import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

import type { ContextEvidence, TaskContextRequest } from "../../domain/task-context.js";
import type { CodeIntelligencePort } from "../../ports/context-providers.js";
import {
  PersistentMcpToolClient,
  createStdioMcpConnection
} from "../../infrastructure/mcp/persistent-mcp-tool-client.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const INTERNAL_CODEGRAPH_TOOLS = "explore,node,search,callers,callees,impact,status";
const CACHE_LIMIT = 64;

const STOP_WORDS = new Set([
  "about", "after", "before", "build", "change", "check", "code", "context", "could", "current",
  "debug", "does", "file", "files", "find", "fix", "from", "function", "implement", "into", "issue",
  "make", "need", "project", "refactor", "remove", "service", "should", "that", "this", "trace",
  "understand", "what", "when", "where", "which", "with", "without", "would", "architecture", "architectural",
  "performance", "improvements", "bottlenecks", "measurable", "speculative", "remaining", "telemetry", "prioritize"
]);

export interface CodeGraphIndexReceipt {
  root: string;
  revision: string | null;
  synced: boolean;
  checkedAt: number;
}

export interface CodeGraphIndexer {
  ensureIndexed(root: string, changedFiles?: readonly string[]): Promise<CodeGraphIndexReceipt>;
}

export interface CodeGraphAdapterOptions {
  client: PersistentMcpToolClient;
  indexer: CodeGraphIndexer;
  rootRevision?: (root: string) => { token: string; cacheable: boolean };
}

interface CodeGraphRoute {
  tool: "codegraph_explore" | "codegraph_node" | "codegraph_search" | "codegraph_callers" | "codegraph_callees" | "codegraph_impact";
  mode: "deep" | "overview" | "search" | "callers" | "callees" | "impact";
  args: Readonly<Record<string, unknown>>;
}

export class CodeGraphAdapter implements CodeIntelligencePort {
  private readonly revisionByRoot = new Map<string, string | null>();
  private readonly cache = new Map<string, readonly ContextEvidence[]>();
  private readonly inFlight = new Map<string, Promise<readonly ContextEvidence[]>>();
  private readonly stageCache = new Map<string, string>();
  private readonly stageInFlight = new Map<string, Promise<string>>();
  private readonly cacheEpochByRoot = new Map<string, number>();
  private readonly telemetryByRoot = new Map<string, Readonly<Record<string, unknown>>>();
  private readonly workspaceRevisionByRoot = new Map<string, string>();
  private readonly indexInFlightByRoot = new Map<string, { token: string | null; promise: Promise<CodeGraphIndexReceipt> }>();
  private readonly prewarmedRoots = new Set<string>();

  constructor(private readonly options: CodeGraphAdapterOptions) {}

  async ensureIndexed(root: string, changedFiles: readonly string[] = []): Promise<void> {
    const normalizedRoot = path.resolve(root);
    const previousRevision = this.revisionByRoot.get(normalizedRoot);
    const startedAt = performance.now();
    const workspaceRevisionBefore = this.options.rootRevision?.(normalizedRoot);
    const relevantChangedFiles = codeGraphRelevantChangedFiles(changedFiles);
    if (previousRevision !== undefined && changedFiles.length > 0 && relevantChangedFiles.length === 0) {
      if (workspaceRevisionBefore?.cacheable) {
        this.workspaceRevisionByRoot.set(normalizedRoot, workspaceRevisionBefore.token);
      }
      this.mergeTelemetry(normalizedRoot, {
        index_ms: elapsedMs(startedAt),
        index_synced: false,
        index_cache_hit: true,
        index_skip_reason: "non_graph_changes"
      });
      return;
    }
    if (
      relevantChangedFiles.length === 0 &&
      workspaceRevisionBefore?.cacheable &&
      previousRevision !== undefined &&
      this.workspaceRevisionByRoot.get(normalizedRoot) === workspaceRevisionBefore.token
    ) {
      this.mergeTelemetry(normalizedRoot, {
        index_ms: elapsedMs(startedAt),
        index_synced: false,
        index_cache_hit: true,
        index_skip_reason: "workspace_revision_unchanged"
      });
      return;
    }
    const pending = this.indexInFlightByRoot.get(normalizedRoot);
    if (pending) {
      const sameRevision = Boolean(
        workspaceRevisionBefore?.cacheable
        && pending.token !== null
        && pending.token === workspaceRevisionBefore.token
      );
      await pending.promise;
      if (sameRevision) {
        this.mergeTelemetry(normalizedRoot, {
          index_ms: elapsedMs(startedAt),
          index_synced: false,
          index_cache_hit: true,
          index_skip_reason: "inflight_join"
        });
        return;
      }
      return this.ensureIndexed(normalizedRoot, changedFiles);
    }

    const token = workspaceRevisionBefore?.cacheable ? workspaceRevisionBefore.token : null;
    const operation = (async () => {
      const receipt = await this.options.indexer.ensureIndexed(normalizedRoot, relevantChangedFiles);
      this.revisionByRoot.set(normalizedRoot, receipt.revision);
      const workspaceRevisionAfter = this.options.rootRevision?.(normalizedRoot);
      if (
        workspaceRevisionBefore?.cacheable &&
        workspaceRevisionAfter?.cacheable &&
        workspaceRevisionBefore.token === workspaceRevisionAfter.token
      ) {
        this.workspaceRevisionByRoot.set(normalizedRoot, workspaceRevisionAfter.token);
      } else {
        this.workspaceRevisionByRoot.delete(normalizedRoot);
      }
      if ((relevantChangedFiles.length > 0 && receipt.synced) || previousRevision !== undefined && previousRevision !== receipt.revision) {
        this.evictRoot(normalizedRoot);
      }
      return receipt;
    })();
    this.indexInFlightByRoot.set(normalizedRoot, { token, promise: operation });
    try {
      const receipt = await operation;
      this.mergeTelemetry(normalizedRoot, {
        index_ms: elapsedMs(startedAt),
        index_synced: receipt.synced,
        index_cache_hit: false,
        index_skip_reason: undefined
      });
    } finally {
      if (this.indexInFlightByRoot.get(normalizedRoot)?.promise === operation) {
        this.indexInFlightByRoot.delete(normalizedRoot);
      }
    }
  }

  async prewarm(root: string): Promise<void> {
    const normalizedRoot = path.resolve(root);
    const startedAt = performance.now();
    await this.ensureIndexed(normalizedRoot);
    if (this.prewarmedRoots.has(normalizedRoot)) {
      this.mergeTelemetry(normalizedRoot, {
        prewarm_ms: elapsedMs(startedAt),
        prewarm_cache_hit: true
      });
      return;
    }
    const result = await this.options.client.callTool("codegraph_status", { projectPath: normalizedRoot });
    if (result.isError) throw new Error(extractText(result) || "CodeGraph status prewarm failed.");
    this.prewarmedRoots.add(normalizedRoot);
    this.mergeTelemetry(normalizedRoot, { prewarm_ms: elapsedMs(startedAt), prewarm_cache_hit: false });
  }

  telemetry(root: string): Readonly<Record<string, unknown>> | undefined {
    return this.telemetryByRoot.get(path.resolve(root));
  }

  close(): Promise<void> {
    this.cache.clear();
    this.inFlight.clear();
    this.stageCache.clear();
    this.stageInFlight.clear();
    this.cacheEpochByRoot.clear();
    this.revisionByRoot.clear();
    this.telemetryByRoot.clear();
    this.workspaceRevisionByRoot.clear();
    this.indexInFlightByRoot.clear();
    this.prewarmedRoots.clear();
    return this.options.client.close();
  }

  async context(request: TaskContextRequest): Promise<readonly ContextEvidence[]> {
    const projectPath = path.resolve(request.root);
    const startedAt = performance.now();
    const route = routeCodeGraphRequest(request, projectPath);
    const revision = this.revisionByRoot.get(projectPath) ?? null;
    const cacheKey = revision ? this.cacheKey(projectPath, revision, route) : null;
    const cacheEpoch = this.cacheEpochByRoot.get(projectPath) ?? 0;

    if (cacheKey) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.touchCache(cacheKey, cached);
        const hit = markCacheHit(cached);
        this.recordContextTelemetry(projectPath, route, startedAt, true);
        return hit;
      }
      const pending = this.inFlight.get(cacheKey);
      if (pending) {
        const hit = markCacheHit(await pending);
        this.recordContextTelemetry(projectPath, route, startedAt, true);
        return hit;
      }
    }

    const operation = this.executeRoute(request, projectPath, revision, route);
    if (!cacheKey) {
      const evidence = await operation;
      this.recordContextTelemetry(projectPath, route, startedAt, false);
      return evidence;
    }

    this.inFlight.set(cacheKey, operation);
    try {
      const evidence = await operation;
      if ((this.cacheEpochByRoot.get(projectPath) ?? 0) === cacheEpoch) {
        this.storeCache(cacheKey, evidence);
      }
      this.recordContextTelemetry(projectPath, route, startedAt, false, Number(evidence[0]?.metadata?.stage_cache_hits ?? 0));
      return evidence;
    } finally {
      if (this.inFlight.get(cacheKey) === operation) this.inFlight.delete(cacheKey);
    }
  }

  private async executeRoute(
    request: TaskContextRequest,
    projectPath: string,
    revision: string | null,
    route: CodeGraphRoute
  ): Promise<readonly ContextEvidence[]> {
    if (route.mode === "deep") {
      const staged = await this.executeStagedDeepRoute(request, projectPath, revision, route);
      if (staged) return staged;
    }
    return this.executeSingleRoute(request, projectPath, revision, route, route.mode === "deep" ? ["search", "relation", "deep"] : [route.mode]);
  }

  private async executeStagedDeepRoute(
    request: TaskContextRequest,
    projectPath: string,
    revision: string | null,
    deepRoute: CodeGraphRoute
  ): Promise<readonly ContextEvidence[] | null> {
    const terms = extractQueryTerms(request.task, request.changedFiles ?? []);
    const primary = terms[0];
    if (!primary) return null;
    const limit = Math.max(3, Math.min(12, request.budget?.maxItems ?? 8));
    const searchRoute: CodeGraphRoute = {
      tool: "codegraph_search",
      mode: "search",
      args: { query: primary, limit, projectPath }
    };
    const search = await this.callRoute(searchRoute, revision);
    const escalationPath: string[] = ["search"];
    if (relationshipSignal(search.content) >= 3) {
      return this.evidenceFromContent(request, projectPath, revision, searchRoute, search.content, escalationPath, Number(search.cacheHit));
    }

    if (!isEmptyGraphResult(search.content)) {
      const relationRoute = stagedRelationRoute(request, primary, projectPath, limit);
      escalationPath.push(relationRoute.mode);
      const relation = await this.callRoute(relationRoute, revision);
      if (relationshipSignal(relation.content) >= 2) {
        return this.evidenceFromContent(request, projectPath, revision, relationRoute, relation.content, escalationPath, Number(search.cacheHit) + Number(relation.cacheHit));
      }
    }

    escalationPath.push("deep");
    const deep = await this.callRoute(deepRoute, revision);
    if (!deep.content.trim()) return [];
    return this.evidenceFromContent(request, projectPath, revision, deepRoute, deep.content, escalationPath, Number(search.cacheHit) + Number(deep.cacheHit));
  }

  private async executeSingleRoute(
    request: TaskContextRequest,
    projectPath: string,
    revision: string | null,
    route: CodeGraphRoute,
    escalationPath: readonly string[]
  ): Promise<readonly ContextEvidence[]> {
    const result = await this.callRoute(route, revision);
    if (!result.content.trim()) return [];
    return this.evidenceFromContent(request, projectPath, revision, route, result.content, escalationPath, Number(result.cacheHit));
  }

  private async callRoute(route: CodeGraphRoute, revision: string | null): Promise<{ content: string; cacheHit: boolean }> {
    const root = path.resolve(String(route.args.projectPath));
    const key = revision ? this.cacheKey(root, revision, route) : null;
    if (key) {
      const cached = this.stageCache.get(key);
      if (cached !== undefined) {
        this.stageCache.delete(key);
        this.stageCache.set(key, cached);
        return { content: cached, cacheHit: true };
      }
      const pending = this.stageInFlight.get(key);
      if (pending) return { content: await pending, cacheHit: true };
    }
    const epoch = this.cacheEpochByRoot.get(root) ?? 0;
    const operation = (async () => {
      const result = await this.options.client.callTool(route.tool, route.args);
      if (result.isError) throw new Error(extractText(result) || `CodeGraph ${route.tool} failed.`);
      return extractText(result).trim();
    })();
    if (key) this.stageInFlight.set(key, operation);
    try {
      const content = await operation;
      if (key && this.revisionByRoot.get(root) === revision && (this.cacheEpochByRoot.get(root) ?? 0) === epoch) {
        this.stageCache.delete(key);
        this.stageCache.set(key, content);
        while (this.stageCache.size > 256) {
          const oldest = this.stageCache.keys().next().value;
          if (oldest === undefined) break;
          this.stageCache.delete(oldest);
        }
      }
      return { content, cacheHit: false };
    } finally {
      if (key && this.stageInFlight.get(key) === operation) this.stageInFlight.delete(key);
    }
  }

  private evidenceFromContent(
    request: TaskContextRequest,
    projectPath: string,
    revision: string | null,
    route: CodeGraphRoute,
    content: string,
    escalationPath: readonly string[],
    stageCacheHits = 0
  ): readonly ContextEvidence[] {
    const compacted = compactCodeGraphContent(content, route.mode);
    const providerCap = route.mode === "deep" ? 6_000 : 4_000;
    const requestedCap = request.budget?.maxChars ?? providerCap;
    const boundedContent = compacted.content.slice(0, Math.max(1_000, Math.min(providerCap, requestedCap)));
    return [{
      id: `codegraph-${shortHash(`${projectPath}\u0000${route.tool}\u0000${stableStringify(route.args)}\u0000${boundedContent}`)}`,
      provider: "codegraph",
      kind: "relationship",
      title: `CodeGraph ${route.mode}: ${request.task}`,
      content: boundedContent,
      score: route.mode === "deep" || route.mode === "impact" ? 91 : 88,
      metadata: {
        tool: route.tool,
        mode: route.mode,
        revision,
        cache_hit: false,
        stage_cache_hits: stageCacheHits,
        cold_router_v2: escalationPath.length > 1,
        escalation_path: escalationPath,
        source_omitted: compacted.sourceOmitted,
        truncated: boundedContent.length < compacted.content.length || compacted.sourceOmitted
      }
    }];
  }

  private recordContextTelemetry(root: string, route: CodeGraphRoute, startedAt: number, cacheHit: boolean, stageCacheHits = 0): void {
    this.mergeTelemetry(root, {
      query_ms: elapsedMs(startedAt),
      route: route.mode,
      cache_hit: cacheHit,
      stage_cache_hits: stageCacheHits
    });
  }

  private mergeTelemetry(root: string, values: Readonly<Record<string, unknown>>): void {
    const normalizedRoot = path.resolve(root);
    this.telemetryByRoot.set(normalizedRoot, {
      ...(this.telemetryByRoot.get(normalizedRoot) ?? {}),
      ...values
    });
  }

  private cacheKey(projectPath: string, revision: string, route: CodeGraphRoute): string {
    return [projectPath, revision, route.tool, stableStringify(route.args)].join("\u0000");
  }

  private storeCache(key: string, evidence: readonly ContextEvidence[]): void {
    this.cache.delete(key);
    this.cache.set(key, evidence);
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  private touchCache(key: string, evidence: readonly ContextEvidence[]): void {
    this.cache.delete(key);
    this.cache.set(key, evidence);
  }

  private evictRoot(root: string): void {
    this.cacheEpochByRoot.set(root, (this.cacheEpochByRoot.get(root) ?? 0) + 1);
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${root}\u0000`)) this.cache.delete(key);
    }
    for (const key of this.inFlight.keys()) {
      if (key.startsWith(`${root}\u0000`)) this.inFlight.delete(key);
    }
    for (const key of this.stageCache.keys()) {
      if (key.startsWith(`${root}\u0000`)) this.stageCache.delete(key);
    }
    for (const key of this.stageInFlight.keys()) {
      if (key.startsWith(`${root}\u0000`)) this.stageInFlight.delete(key);
    }
  }
}

export interface CodeGraphCliIndexerOptions {
  command: string;
  prefixArgs?: readonly string[];
  env?: Readonly<Record<string, string>>;
  syncTtlMs?: number;
}

export class CodeGraphCliIndexer implements CodeGraphIndexer {
  private readonly lastSyncByRoot = new Map<string, number>();
  private readonly lastReceiptByRoot = new Map<string, CodeGraphIndexReceipt>();
  private readonly lastChangedFilesRevisionByRoot = new Map<string, string>();
  private readonly inFlightByRoot = new Map<string, Promise<CodeGraphIndexReceipt>>();
  private readonly syncTtlMs: number;

  constructor(private readonly options: CodeGraphCliIndexerOptions) {
    this.syncTtlMs = options.syncTtlMs ?? 60_000;
  }

  async ensureIndexed(root: string, changedFiles: readonly string[] = []): Promise<CodeGraphIndexReceipt> {
    const normalizedRoot = path.resolve(root);
    const forceSync = changedFiles.length > 0;
    const pending = this.inFlightByRoot.get(normalizedRoot);
    if (pending) {
      const completed = await pending;
      if (!forceSync) return { ...completed, synced: false, checkedAt: Date.now() };
    }

    const operation = this.ensureIndexedOnce(normalizedRoot, changedFiles);
    this.inFlightByRoot.set(normalizedRoot, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlightByRoot.get(normalizedRoot) === operation) this.inFlightByRoot.delete(normalizedRoot);
    }
  }

  private async ensureIndexedOnce(normalizedRoot: string, changedFiles: readonly string[]): Promise<CodeGraphIndexReceipt> {
    const databasePath = path.join(normalizedRoot, ".codegraph", "codegraph.db");
    const lastSync = this.lastSyncByRoot.get(normalizedRoot) ?? 0;
    const cached = this.lastReceiptByRoot.get(normalizedRoot);
    const changedFilesRevision = changedFiles.length > 0
      ? await changedFilesRevisionToken(normalizedRoot, changedFiles)
      : null;
    const forceSync = changedFilesRevision !== null
      && this.lastChangedFilesRevisionByRoot.get(normalizedRoot) !== changedFilesRevision;
    if (!forceSync && cached && Date.now() - lastSync < this.syncTtlMs) {
      const revision = await databaseRevision(databasePath);
      const receipt = { ...cached, revision, synced: false, checkedAt: Date.now() };
      this.lastReceiptByRoot.set(normalizedRoot, receipt);
      return receipt;
    }

    const initialized = await exists(databasePath);
    const args = initialized
      ? [...(this.options.prefixArgs ?? []), "sync", "--quiet", normalizedRoot]
      : [...(this.options.prefixArgs ?? []), "init", normalizedRoot];

    await execFileAsync(this.options.command, args, {
      cwd: normalizedRoot,
      env: {
        ...process.env,
        CODEGRAPH_TELEMETRY: "0",
        ...(this.options.env ?? {})
      },
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    });

    const receipt: CodeGraphIndexReceipt = {
      root: normalizedRoot,
      revision: await databaseRevision(databasePath),
      synced: true,
      checkedAt: Date.now()
    };
    this.lastSyncByRoot.set(normalizedRoot, receipt.checkedAt);
    this.lastReceiptByRoot.set(normalizedRoot, receipt);
    if (changedFilesRevision !== null) {
      this.lastChangedFilesRevisionByRoot.set(normalizedRoot, changedFilesRevision);
    }
    return receipt;
  }
}

export function createDefaultCodeGraphAdapter(options: {
  rootRevision?: (root: string) => { token: string; cacheable: boolean };
} = {}): CodeGraphAdapter {
  const packageJson = require.resolve("@colbymchenry/codegraph/package.json");
  const shimPath = path.join(path.dirname(packageJson), "npm-shim.js");
  const command = process.execPath;
  const prefixArgs = [shimPath];
  const client = new PersistentMcpToolClient(() => createStdioMcpConnection({
    command,
    args: [...prefixArgs, "serve", "--mcp"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEGRAPH_TELEMETRY: "0",
      CODEGRAPH_MCP_TOOLS: INTERNAL_CODEGRAPH_TOOLS
    },
    clientName: "lca-codegraph-adapter",
    clientVersion: "0.2.0"
  }));

  return new CodeGraphAdapter({
    client,
    indexer: new CodeGraphCliIndexer({ command, prefixArgs }),
    ...(options.rootRevision ? { rootRevision: options.rootRevision } : {})
  });
}

function routeCodeGraphRequest(request: TaskContextRequest, projectPath: string): CodeGraphRoute {
  const terms = extractQueryTerms(request.task, request.changedFiles ?? []);
  const primary = terms[0] ?? "";
  const task = request.task.toLowerCase();
  const limit = Math.max(3, Math.min(12, request.budget?.maxItems ?? 8));

  if (primary && (request.intent === "refactor" || /\b(?:impact|affected|blast radius|breaking|tác động|ảnh hưởng)\b/i.test(request.task))) {
    return {
      tool: "codegraph_impact",
      mode: "impact",
      args: { symbol: primary, depth: request.intent === "refactor" ? 2 : 3, projectPath }
    };
  }
  if (primary && /\b(?:callers?|references?|referenced by|used by|usage|who calls|ai gọi|tham chiếu)\b/i.test(request.task)) {
    return {
      tool: "codegraph_callers",
      mode: "callers",
      args: { symbol: primary, limit, projectPath }
    };
  }
  if (primary && /\b(?:callees?|calls|depends on|dependencies|what .* calls|phụ thuộc|gọi gì)\b/i.test(request.task)) {
    return {
      tool: "codegraph_callees",
      mode: "callees",
      args: { symbol: primary, limit, projectPath }
    };
  }
  if (isDeepStructuralTask(task, request.intent, terms.length)) {
    const query = terms.length > 0 ? terms.slice(0, 8).join(" ") : request.task.slice(0, 600);
    return {
      tool: "codegraph_explore",
      mode: "deep",
      args: {
        query,
        projectPath,
        maxFiles: Math.max(2, Math.min(6, request.budget?.maxItems ?? 4))
      }
    };
  }
  if (primary) {
    return {
      tool: "codegraph_search",
      mode: "search",
      args: { query: primary, limit, projectPath }
    };
  }
  if ((request.changedFiles ?? []).length === 1) {
    return {
      tool: "codegraph_node",
      mode: "overview",
      args: { file: request.changedFiles![0], symbolsOnly: true, projectPath }
    };
  }

  return {
    tool: "codegraph_explore",
    mode: "deep",
    args: {
      query: request.task.slice(0, 600),
      projectPath,
      maxFiles: Math.max(2, Math.min(4, request.budget?.maxItems ?? 3))
    }
  };
}

function stagedRelationRoute(
  request: TaskContextRequest,
  primary: string,
  projectPath: string,
  limit: number
): CodeGraphRoute {
  const task = request.task.toLowerCase();
  if (request.intent === "review" || /\b(?:architecture|architectural|relationship|cross-module|blast radius|affected|impact)\b/i.test(task)) {
    return { tool: "codegraph_impact", mode: "impact", args: { symbol: primary, depth: 2, projectPath } };
  }
  return { tool: "codegraph_callers", mode: "callers", args: { symbol: primary, limit, projectPath } };
}

function isEmptyGraphResult(content: string): boolean {
  const text = String(content || "").trim();
  return !text || /^(?:no results?|not found|no matches?)/i.test(text) || /no results found/i.test(text);
}

function relationshipSignal(content: string): number {
  const text = String(content || "").trim();
  if (isEmptyGraphResult(text)) return 0;
  let score = 0;
  const fileRefs = text.match(/(?:^|\s)[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|dart|java|py|go|rs|cs)(?::\d+)?/g) ?? [];
  if (fileRefs.length >= 1) score += 1;
  if (fileRefs.length >= 2) score += 1;
  if (/\b(?:caller|callee|affected|depends|dependency|blast radius|references?|used by|impact)\b/i.test(text)) score += 2;
  if (/\b(?:found|symbols?)\b/i.test(text) && /\bacross\b/i.test(text)) score += 1;
  if (text.split(/\r?\n/).filter(Boolean).length >= 5) score += 1;
  return score;
}

function isDeepStructuralTask(task: string, intent: TaskContextRequest["intent"], termCount: number): boolean {
  if (/\b(?:architecture|architectural|flow|call path|end-to-end|relationship|cross-module|across modules|kiến trúc|luồng|quan hệ)\b/i.test(task)) return true;
  if (/\btrace\b/i.test(task) && termCount >= 2) return true;
  if (/\bhow\b.*\b(?:work|reach|flow|connect)\b/i.test(task)) return true;
  return intent === "understand" && termCount >= 4;
}

function extractQueryTerms(task: string, changedFiles: readonly string[]): string[] {
  const taskTerms = String(task).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  const fileTerms = changedFiles.flatMap((file) => {
    const base = path.basename(file).replace(/\.[^.]+$/, "");
    return base.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  });
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
    .slice(0, 10);
}

function termPriority(term: string): number {
  let score = 0;
  if (/[A-Z]/.test(term.slice(1))) score += 5;
  if (/[_$]/.test(term)) score += 2;
  if (term.length >= 8) score += 1;
  return score;
}

function compactCodeGraphContent(content: string, mode: CodeGraphRoute["mode"]): { content: string; sourceOmitted: boolean } {
  if (mode !== "deep") return { content, sourceOmitted: false };
  const markers = ["\n**Source Code**", "\n## Source Code", "\nSource Code\n"];
  let cut = -1;
  for (const marker of markers) {
    const index = content.indexOf(marker);
    if (index >= 0 && (cut < 0 || index < cut)) cut = index;
  }
  if (cut < 0) return { content, sourceOmitted: false };
  const summary = content.slice(0, cut).trimEnd();
  return {
    content: `${summary}\n\nSource snippets omitted from compact context; read the cited files/symbols when exact code is needed.`,
    sourceOmitted: true
  };
}

function markCacheHit(evidence: readonly ContextEvidence[]): readonly ContextEvidence[] {
  return evidence.map((item) => ({
    ...item,
    metadata: { ...(item.metadata ?? {}), cache_hit: true }
  }));
}

function extractText(result: { content?: readonly { type: string; text?: string }[] }): string {
  return (result.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("\n");
}

function stableStringify(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function codeGraphRelevantChangedFiles(changedFiles: readonly string[]): readonly string[] {
  return changedFiles.filter((file) => !isDefinitelyNonGraphFile(file));
}

function isDefinitelyNonGraphFile(file: string): boolean {
  const normalized = file.replaceAll("\\", "/").toLowerCase();
  if (/(?:^|\/)(?:\.git|\.codegraph|\.agent\/state|runtime\/agentmemory)(?:\/|$)/.test(normalized)) return true;
  return /\.(?:md|mdx|rst|adoc|txt|log|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|mp3|wav|mp4|mov|webm)$/i.test(normalized);
}

export async function changedFilesRevisionToken(root: string, changedFiles: readonly string[]): Promise<string> {
  const normalized = [...new Set(changedFiles.map((file) => path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file)))].sort();
  const hash = createHash("sha256");
  for (const file of normalized) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    try {
      const metadata = await stat(file);
      hash.update(`${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`);
    } catch {
      hash.update("missing");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function databaseRevision(databasePath: string): Promise<string | null> {
  try {
    const database = await stat(databasePath);
    let wal = "missing";
    try {
      const metadata = await stat(`${databasePath}-wal`);
      wal = `${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
    } catch {
      // SQLite may checkpoint and remove the WAL between reads.
    }
    return shortHash(`${database.size}:${database.mtimeMs}:${database.ctimeMs}\u0000${wal}`);
  } catch {
    return null;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
}
