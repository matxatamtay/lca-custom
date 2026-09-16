import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import type { ContextEvidence, TaskContextRequest } from "../../domain/task-context.js";
import type { SemanticContextState } from "../../ports/context-providers.js";
import { StdioLspClient, type LspClientLike, type StdioLspClientOptions } from "../../infrastructure/lsp/stdio-lsp-client.js";
import type { SemanticEngineResult } from "./semantic-context-adapter.js";

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

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface LspLocation { uri: string; range: LspRange }
interface LspSymbol { name: string; kind?: number; location: LspLocation }
interface CompactLocation { path: string; line: number; column: number }

const STOP_WORDS = new Set([
  "about", "after", "before", "build", "change", "check", "code", "context", "could", "current",
  "caller", "callers", "definition", "definitions", "does", "file", "files", "find", "from", "function", "implement", "into", "issue", "make", "need",
  "project", "refactor", "reference", "references", "remove", "service", "should", "that", "this", "trace", "understand", "what",
  "when", "where", "which", "with", "without", "would"
]);

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

async function serverRequestHandler(method: string, params: unknown): Promise<unknown> {
  if (method === "workspace/configuration") {
    const items = asRecord(params).items;
    return Array.isArray(items) ? items.map(() => null) : [];
  }
  if (method === "window/workDoneProgress/create" || method === "client/registerCapability" || method === "client/unregisterCapability") {
    return null;
  }
  return null;
}

function extractQueryTerms(task: string, changedFiles: readonly string[], language: "dart" | "java"): string[] {
  const extension = language === "dart" ? /\.dart$/i : /\.java$/i;
  const taskTerms = String(task).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  const fileTerms = changedFiles.flatMap((file) => path.basename(file).replace(extension, "").match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
  const seen = new Set<string>();
  return [...taskTerms, ...fileTerms]
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term.toLowerCase()))
    .sort((left, right) => termPriority(right) - termPriority(left) || right.length - left.length)
    .filter((term) => {
      const key = term.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function termPriority(term: string): number {
  let score = 0;
  if (/[A-Z]/.test(term.slice(1))) score += 4;
  if (/[_$]/.test(term)) score += 2;
  if (term.length >= 8) score += 1;
  return score;
}

function parseSymbol(value: unknown): LspSymbol | null {
  const record = asRecord(value);
  const name = typeof record.name === "string" ? record.name : "";
  const location = parseLocation(record.location);
  if (!name || !location) return null;
  return {
    name,
    ...(typeof record.kind === "number" ? { kind: record.kind } : {}),
    location
  };
}

function parseSymbols(value: unknown): readonly LspSymbol[] {
  return Array.isArray(value)
    ? value.map(parseSymbol).filter((item): item is LspSymbol => item !== null)
    : [];
}

function parseLocation(value: unknown): LspLocation | null {
  const record = asRecord(value);
  const uri = typeof record.uri === "string" ? record.uri : "";
  const range = parseRange(record.range);
  return uri && range ? { uri, range } : null;
}

function parseRange(value: unknown): LspRange | null {
  const record = asRecord(value);
  const start = parsePosition(record.start);
  const end = parsePosition(record.end);
  return start && end ? { start, end } : null;
}

function parsePosition(value: unknown): LspPosition | null {
  const record = asRecord(value);
  return typeof record.line === "number" && typeof record.character === "number"
    ? { line: record.line, character: record.character }
    : null;
}

function locationsFromResult(value: unknown): LspLocation[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const result: LspLocation[] = [];
  for (const item of values) {
    const record = asRecord(item);
    const direct = parseLocation(record);
    if (direct) {
      result.push(direct);
      continue;
    }
    const targetUri = typeof record.targetUri === "string" ? record.targetUri : "";
    const targetRange = parseRange(record.targetSelectionRange ?? record.targetRange);
    if (targetUri && targetRange) result.push({ uri: targetUri, range: targetRange });
  }
  return result;
}

async function symbolPosition(symbol: LspSymbol): Promise<LspPosition> {
  const start = symbol.location.range.start;
  if (!symbol.location.uri.startsWith("file:")) return start;
  try {
    const file = fileURLToPath(symbol.location.uri);
    const text = await readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    const lastLine = Math.min(symbol.location.range.end.line, start.line + 12, lines.length - 1);
    const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(symbol.name)}([^A-Za-z0-9_$]|$)`);
    for (let line = Math.max(0, start.line); line <= lastLine; line += 1) {
      const value = lines[line] ?? "";
      const match = pattern.exec(value);
      if (match) return { line, character: match.index + (match[1]?.length ?? 0) };
    }
  } catch {
    // Fall back to the symbol range start.
  }
  return start;
}

function compactLocation(root: string, location: LspLocation): CompactLocation | null {
  if (!location.uri.startsWith("file:")) return null;
  try {
    const file = fileURLToPath(location.uri);
    if (!isPathWithin(root, file)) return null;
    const relative = path.relative(root, file);
    return {
      path: relative && !relative.startsWith("..") ? relative : file,
      line: location.range.start.line + 1,
      column: location.range.start.character + 1
    };
  } catch {
    return null;
  }
}

function uniqueLocations(locations: readonly CompactLocation[]): CompactLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.path}:${location.line}:${location.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isWithinRoot(root: string, uri: string): boolean {
  if (!uri.startsWith("file:")) return false;
  try { return isPathWithin(root, fileURLToPath(uri)); } catch { return false; }
}

function isPathWithin(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function symbolRank(name: string, term: string): number {
  const left = name.toLowerCase();
  const right = term.toLowerCase();
  if (left === right) return 4;
  if (left.startsWith(right)) return 3;
  if (left.includes(right)) return 2;
  return 1;
}

function selectRelevantSymbols(symbols: readonly LspSymbol[], term: string): LspSymbol[] {
  const ranked = [...symbols].sort((left, right) => symbolRank(right.name, term) - symbolRank(left.name, term));
  const exact = ranked.filter((symbol) => symbol.name.toLowerCase() === term.toLowerCase());
  if (exact.length > 0) return exact;
  return ranked.filter((symbol) => symbolRank(symbol.name, term) >= 2);
}

function displayLanguage(language: "dart" | "java"): string {
  return language === "dart" ? "Dart" : "Java";
}

function formatLocation(location: CompactLocation): string {
  return `${location.path}:${location.line}:${location.column}`;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
