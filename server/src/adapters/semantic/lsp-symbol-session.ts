import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import type { ContextEvidence, TaskContextRequest } from "../../domain/task-context.js";
import type { SemanticContextState, SemanticDiagnostic, SemanticDiagnosticsResult } from "../../ports/context-providers.js";
import { StdioLspClient, type LspClientLike, type StdioLspClientOptions } from "../../infrastructure/lsp/stdio-lsp-client.js";
import type { SemanticEngineResult } from "./semantic-context-adapter.js";
import {
  compactLocation, displayLanguage, extractQueryTerms, formatLocation, isWithinRoot,
  locationsFromResult, parseSymbols, selectRelevantSymbols, serverRequestHandler, shortHash,
  symbolPosition, uniqueLocations, type CompactLocation, type LspSymbol
} from "./lsp-symbol-utils.js";

export interface LspSymbolSessionOptions {
  language: "dart" | "java";
  engineName: string;
  root: string;
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  createClient?: (options: StdioLspClientOptions) => LspClientLike;
  readiness: (method: string, params: unknown) => "warming" | "ready" | undefined;
  initializationOptions?: unknown;
  initializeTimeoutMs?: number;
  queryTimeoutMs?: number;
  warmupTimeoutMs?: number;
  readyQuietPeriodMs?: number;
  warmupProbeTimeoutMs?: number;
}

type SessionState = "cold" | "warming" | "ready" | "failed" | "closed";

export class LspSymbolSession {
  private state: SessionState = "cold";
  private reason = "Semantic analyzer has not started yet.";
  private client: LspClientLike | undefined;
  private startPromise: Promise<void> | undefined;
  private warmupTimer: NodeJS.Timeout | undefined;
  private readyTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private readinessGeneration = 0;
  private warmupTerm: string | undefined;
  private readonly symbolCache = new Map<string, readonly LspSymbol[]>();
  private readonly evidenceCache = new Map<string, readonly ContextEvidence[]>();
  private readonly diagnosticsByUri = new Map<string, readonly SemanticDiagnostic[]>();
  private readonly diagnosticGenerationByUri = new Map<string, number>();

  constructor(private readonly options: LspSymbolSessionOptions) {}

  context(request: TaskContextRequest): Promise<SemanticEngineResult> {
    const terms = extractQueryTerms(request.task, request.changedFiles ?? [], this.options.language);
    if (!this.warmupTerm && terms[0]) this.warmupTerm = terms[0];
    if (this.state === "cold") this.prewarm();
    if (this.state !== "ready") {
      return Promise.resolve({
        evidence: [],
        state: this.semanticState(),
        reason: this.reason
      });
    }
    return this.query(request);
  }

  async diagnostics(changedFiles: readonly string[]): Promise<SemanticDiagnosticsResult> {
    if (this.state === "cold") this.prewarm();
    if (this.state !== "ready") {
      return {
        diagnostics: [],
        language: this.options.language,
        engine: this.options.engineName,
        available: false,
        state: this.semanticState(),
        fresh: false,
        reason: this.reason
      };
    }

    const uris = changedFiles.map((file) => {
      const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(this.options.root, file);
      return pathToFileURL(absolute).toString();
    });
    const before = new Map(uris.map((uri) => [uri, this.diagnosticGenerationByUri.get(uri) ?? 0]));
    this.notifyFileChanges(changedFiles);
    const fresh = await this.waitForDiagnostics(uris, before, 180);
    const diagnostics = uris.flatMap((uri) => this.diagnosticsByUri.get(uri) ?? []);
    return {
      diagnostics: diagnostics.slice(0, 100),
      language: this.options.language,
      engine: this.options.engineName,
      available: true,
      state: "ready",
      fresh,
      ...(fresh ? {} : { reason: "Language server did not publish fresh diagnostics within the post-edit window." })
    };
  }

  prewarm(): void {
    if (this.state !== "cold") return;
    this.state = "warming";
    this.reason = `${this.options.engineName} is warming the ${this.options.language} workspace in the background.`;
    this.startPromise = this.start().catch((error) => {
      this.fail(error instanceof Error ? error.message : String(error));
    });
  }

  async close(): Promise<void> {
    this.state = "closed";
    if (this.warmupTimer) clearTimeout(this.warmupTimer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    try { await this.startPromise; } catch { /* startup failure already captured */ }
    await this.client?.close();
    this.client = undefined;
  }

  private async start(): Promise<void> {
    const clientOptions: StdioLspClientOptions = {
      command: this.options.command,
      cwd: this.options.root,
      ...(this.options.args ? { args: this.options.args } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      requestTimeoutMs: this.options.queryTimeoutMs ?? 900,
      serverRequestHandler: serverRequestHandler
    };
    this.client = this.options.createClient?.(clientOptions) ?? new StdioLspClient(clientOptions);
    this.unsubscribe = this.client.onNotification((method, params) => {
      if (method === "textDocument/publishDiagnostics") this.captureDiagnostics(params);
      const next = this.options.readiness(method, params);
      if (next === "warming") {
        this.readinessGeneration += 1;
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.readyTimer = undefined;
        this.state = "warming";
        this.reason = `${this.options.engineName} is analyzing the workspace in the background.`;
      } else if (next === "ready") {
        this.scheduleReady(this.readinessGeneration);
      }
    });
    await this.client.start();
    const rootUri = pathToFileURL(this.options.root).toString();
    await this.client.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.options.root) || this.options.language }],
      capabilities: {
        workspace: { configuration: true, symbol: {} },
        window: { workDoneProgress: true },
        textDocument: { definition: {}, references: {} }
      },
      ...(this.options.initializationOptions !== undefined
        ? { initializationOptions: this.options.initializationOptions }
        : {})
    }, this.options.initializeTimeoutMs ?? 12_000);
    this.client.notify("initialized", {});
    this.warmupTimer = setTimeout(() => {
      if (this.state === "warming") {
        this.fail(`${this.options.engineName} did not report analysis readiness within ${this.options.warmupTimeoutMs ?? 60_000}ms.`);
      }
    }, this.options.warmupTimeoutMs ?? 60_000);
    this.warmupTimer.unref?.();
  }

  private async query(request: TaskContextRequest): Promise<SemanticEngineResult> {
    const client = this.client;
    if (!client) {
      return { evidence: [], state: "unavailable", reason: `${this.options.engineName} client is not running.` };
    }
    this.notifyFileChanges(request.changedFiles ?? []);
    const terms = extractQueryTerms(request.task, request.changedFiles ?? [], this.options.language);
    if (terms.length === 0) return { evidence: [], state: "ready" };

    const maxItems = Math.max(1, Math.min(8, request.budget?.maxItems ?? 6));
    const maxChars = Math.max(1_000, Math.min(30_000, request.budget?.maxChars ?? 12_000));
    const queryTimeoutMs = this.options.queryTimeoutMs ?? 900;
    const cachedEvidence = terms.flatMap((term) => this.evidenceCache.get(term) ?? []);
    if (cachedEvidence.length > 0) {
      return { evidence: cachedEvidence.slice(0, maxItems), state: "ready" };
    }
    const symbols = await this.findSymbols(client, terms, maxItems, queryTimeoutMs);
    const perItemBudget = Math.max(700, Math.floor(maxChars / Math.max(1, symbols.length)));
    const evidence = await Promise.all(symbols.map((symbol) => this.toEvidence(client, symbol, queryTimeoutMs, perItemBudget)));
    return { evidence, state: "ready" };
  }

  private async findSymbols(
    client: LspClientLike,
    terms: readonly string[],
    maxItems: number,
    timeoutMs: number
  ): Promise<readonly LspSymbol[]> {
    const seen = new Set<string>();
    const matches: LspSymbol[] = [];
    for (const term of terms.slice(0, 5)) {
      let items = this.symbolCache.get(term);
      if (!items) {
        let raw: unknown;
        try {
          raw = await client.request("workspace/symbol", { query: term }, timeoutMs);
        } catch {
          continue;
        }
        items = parseSymbols(raw);
        this.symbolCache.set(term, items);
      }
      const rankedItems = selectRelevantSymbols(items, term);
      for (const item of rankedItems) {
        if (matches.length >= maxItems) return matches;
        if (!isWithinRoot(this.options.root, item.location.uri)) continue;
        const key = `${item.name}\u0000${item.location.uri}\u0000${item.location.range.start.line}:${item.location.range.start.character}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push(item);
      }
    }
    return matches;
  }

  private async toEvidence(
    client: LspClientLike,
    symbol: LspSymbol,
    timeoutMs: number,
    maxChars: number
  ): Promise<ContextEvidence> {
    const position = await symbolPosition(symbol);
    const document = { uri: symbol.location.uri };
    const [definitionResult, referenceResult] = await Promise.allSettled([
      client.request("textDocument/definition", { textDocument: document, position }, timeoutMs),
      client.request("textDocument/references", {
        textDocument: document,
        position,
        context: { includeDeclaration: false }
      }, timeoutMs)
    ]);
    const definitions = uniqueLocations([
      symbol.location,
      ...locationsFromResult(definitionResult.status === "fulfilled" ? definitionResult.value : null)
    ].map((location) => compactLocation(this.options.root, location)).filter((item): item is CompactLocation => item !== null)).slice(0, 6);
    const references = uniqueLocations(
      locationsFromResult(referenceResult.status === "fulfilled" ? referenceResult.value : null)
        .map((location) => compactLocation(this.options.root, location))
        .filter((item): item is CompactLocation => item !== null)
    ).slice(0, 16);
    const content = [
      `${symbol.name}`,
      `Definitions (${definitions.length}):`,
      ...(definitions.length ? definitions.map((item) => `- ${formatLocation(item)}`) : ["- no in-project definition resolved"]),
      `References (${references.length}):`,
      ...(references.length ? references.map((item) => `- ${formatLocation(item)}`) : ["- no in-project references resolved"])
    ].join("\n");
    const bounded = content.slice(0, maxChars);
    return {
      id: `semantic-${this.options.language}-${shortHash(`${this.options.root}\u0000${symbol.name}\u0000${content}`)}`,
      provider: "semantic",
      kind: "relationship",
      title: `${displayLanguage(this.options.language)} semantic symbol: ${symbol.name}`,
      content: bounded,
      symbol: symbol.name,
      ...(definitions[0]?.path ? { path: definitions[0].path } : {}),
      score: 94,
      metadata: {
        language: this.options.language,
        engine: this.options.engineName,
        definition_count: definitions.length,
        reference_count: references.length,
        truncated: bounded.length < content.length
      }
    };
  }

  private notifyFileChanges(files: readonly string[]): void {
    if (!this.client || files.length === 0) return;
    this.symbolCache.clear();
    this.evidenceCache.clear();
    const changes = files.map((file) => {
      const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(this.options.root, file);
      return { uri: pathToFileURL(absolute).toString(), type: existsSync(absolute) ? 2 : 3 };
    });
    try { this.client.notify("workspace/didChangeWatchedFiles", { changes }); } catch { /* analyzer may not register watchers */ }
  }

  private captureDiagnostics(params: unknown): void {
    const record = params && typeof params === "object" ? params as Record<string, unknown> : {};
    const uri = typeof record.uri === "string" ? record.uri : "";
    if (!uri) return;
    const raw = Array.isArray(record.diagnostics) ? record.diagnostics : [];
    const diagnostics = raw.flatMap((value): SemanticDiagnostic[] => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      const range = item.range && typeof item.range === "object" ? item.range as Record<string, unknown> : {};
      const start = range.start && typeof range.start === "object" ? range.start as Record<string, unknown> : {};
      let filePath: string | undefined;
      try {
        const absolute = fileURLToPath(uri);
        const relative = path.relative(this.options.root, absolute);
        filePath = relative && !relative.startsWith("..") ? relative : absolute;
      } catch {
        filePath = uri;
      }
      return [{
        ...(filePath ? { path: filePath } : {}),
        ...(Number.isInteger(start.line) ? { line: Number(start.line) + 1 } : {}),
        ...(Number.isInteger(start.character) ? { column: Number(start.character) + 1 } : {}),
        severity: lspDiagnosticSeverity(item.severity),
        ...(typeof item.code === "string" || typeof item.code === "number" ? { code: item.code } : {}),
        message: typeof item.message === "string" ? item.message : "Language server diagnostic"
      }];
    });
    this.diagnosticsByUri.set(uri, diagnostics);
    this.diagnosticGenerationByUri.set(uri, (this.diagnosticGenerationByUri.get(uri) ?? 0) + 1);
  }

  private async waitForDiagnostics(
    uris: readonly string[],
    before: ReadonlyMap<string, number>,
    timeoutMs: number
  ): Promise<boolean> {
    if (uris.length === 0) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (uris.every((uri) => (this.diagnosticGenerationByUri.get(uri) ?? 0) > (before.get(uri) ?? 0))) return true;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    return uris.every((uri) => (this.diagnosticGenerationByUri.get(uri) ?? 0) > (before.get(uri) ?? 0));
  }

  private markReady(): void {
    if (this.state === "closed") return;
    this.state = "ready";
    this.reason = `${this.options.engineName} is ready.`;
    if (this.warmupTimer) clearTimeout(this.warmupTimer);
    this.warmupTimer = undefined;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
  }

  private scheduleReady(generation: number): void {
    if (this.state === "closed") return;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    const quietMs = Math.max(0, this.options.readyQuietPeriodMs ?? 0);
    if (quietMs === 0) {
      void this.finishWarmup(generation);
      return;
    }
    this.readyTimer = setTimeout(() => void this.finishWarmup(generation), quietMs);
    this.readyTimer.unref?.();
  }

  private async finishWarmup(generation: number): Promise<void> {
    if (this.state === "closed" || generation !== this.readinessGeneration) return;
    const client = this.client;
    const term = this.warmupTerm;
    if (client && term && !this.symbolCache.has(term)) {
      try {
        const raw = await client.request(
          "workspace/symbol",
          { query: term },
          this.options.warmupProbeTimeoutMs ?? 10_000
        );
        if (generation !== this.readinessGeneration) return;
        const symbols = parseSymbols(raw);
        this.symbolCache.set(term, symbols);
        const first = selectRelevantSymbols(symbols, term)[0];
        if (first) {
          const evidence = await this.toEvidence(
            client,
            first,
            this.options.warmupProbeTimeoutMs ?? 10_000,
            8_000
          );
          if (generation !== this.readinessGeneration) return;
          this.evidenceCache.set(term, [evidence]);
        }
      } catch {
        if (this.state === "warming" && generation === this.readinessGeneration) {
          this.reason = `${this.options.engineName} is still warming the workspace symbol index in the background.`;
          this.readyTimer = setTimeout(() => void this.finishWarmup(generation), 1_000);
          this.readyTimer.unref?.();
        }
        return;
      }
    }
    if (generation === this.readinessGeneration) this.markReady();
  }

  private fail(reason: string): void {
    if (this.state === "closed") return;
    this.state = "failed";
    this.reason = reason;
    if (this.warmupTimer) clearTimeout(this.warmupTimer);
    this.warmupTimer = undefined;
  }

  private semanticState(): SemanticContextState {
    return this.state === "warming" || this.state === "cold" ? "warming" : "unavailable";
  }
}

function lspDiagnosticSeverity(value: unknown): SemanticDiagnostic["severity"] {
  if (value === 1) return "error";
  if (value === 2) return "warning";
  if (value === 3) return "suggestion";
  return "message";
}
