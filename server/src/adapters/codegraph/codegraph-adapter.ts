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
  "understand", "what", "when", "where", "which", "with", "without", "would"
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

  constructor(private readonly options: CodeGraphAdapterOptions) {}

  async ensureIndexed(root: string, changedFiles: readonly string[] = []): Promise<void> {
    const normalizedRoot = path.resolve(root);
    const previousRevision = this.revisionByRoot.get(normalizedRoot);
    const receipt = await this.options.indexer.ensureIndexed(normalizedRoot, changedFiles);
    this.revisionByRoot.set(normalizedRoot, receipt.revision);
    if (changedFiles.length > 0 || previousRevision !== undefined && previousRevision !== receipt.revision) {
      this.evictRoot(normalizedRoot);
    }
  }

  close(): Promise<void> {
    this.cache.clear();
    this.inFlight.clear();
    this.revisionByRoot.clear();
    return this.options.client.close();
  }

  async context(request: TaskContextRequest): Promise<readonly ContextEvidence[]> {
    const projectPath = path.resolve(request.root);
    const route = routeCodeGraphRequest(request, projectPath);
    const revision = this.revisionByRoot.get(projectPath) ?? null;
    const cacheKey = revision ? this.cacheKey(projectPath, revision, route) : null;

    if (cacheKey) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.touchCache(cacheKey, cached);
        return markCacheHit(cached);
      }
      const pending = this.inFlight.get(cacheKey);
      if (pending) return markCacheHit(await pending);
    }

    const operation = this.executeRoute(request, projectPath, revision, route);
    if (!cacheKey) return operation;

    this.inFlight.set(cacheKey, operation);
    try {
      const evidence = await operation;
      this.storeCache(cacheKey, evidence);
      return evidence;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  private async executeRoute(
    request: TaskContextRequest,
    projectPath: string,
    revision: string | null,
    route: CodeGraphRoute
  ): Promise<readonly ContextEvidence[]> {
    const result = await this.options.client.callTool(route.tool, route.args);
    if (result.isError) {
      throw new Error(extractText(result) || `CodeGraph ${route.tool} failed.`);
    }

    const content = extractText(result).trim();
    if (!content) return [];
    const providerCap = route.mode === "deep" ? 14_000 : 8_000;
    const requestedCap = request.budget?.maxChars ?? providerCap;
    const boundedContent = content.slice(0, Math.max(1_000, Math.min(providerCap, requestedCap)));

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
        truncated: boundedContent.length < content.length
      }
    }];
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
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${root}\u0000`)) this.cache.delete(key);
    }
    for (const key of this.inFlight.keys()) {
      if (key.startsWith(`${root}\u0000`)) this.inFlight.delete(key);
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
  private readonly syncTtlMs: number;

  constructor(private readonly options: CodeGraphCliIndexerOptions) {
    this.syncTtlMs = options.syncTtlMs ?? 60_000;
  }

  async ensureIndexed(root: string, changedFiles: readonly string[] = []): Promise<CodeGraphIndexReceipt> {
    const normalizedRoot = path.resolve(root);
    const databasePath = path.join(normalizedRoot, ".codegraph", "codegraph.db");
    const lastSync = this.lastSyncByRoot.get(normalizedRoot) ?? 0;
    const cached = this.lastReceiptByRoot.get(normalizedRoot);
    const forceSync = changedFiles.length > 0;
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
    return receipt;
  }
}

export function createDefaultCodeGraphAdapter(): CodeGraphAdapter {
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
    indexer: new CodeGraphCliIndexer({ command, prefixArgs })
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
