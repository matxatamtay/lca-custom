import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

import type { ContextEvidence, TaskContextRequest } from "../../domain/task-context.js";
import type {
  FilesystemContextPort,
  SemanticContextPort,
  SemanticContextResult,
  SemanticDiagnosticsResult
} from "../../ports/context-providers.js";

const DEFAULT_CACHE_LIMIT = 64;

export interface RootRevision {
  token: string;
  cacheable: boolean;
}

export interface RootRevisionSource {
  revision(root: string): RootRevision;
  bump(root: string): void;
  close?(): void;
}

interface RevisionState {
  generation: number;
  cacheable: boolean;
  watcher?: FSWatcher;
}

export class WorkspaceRevisionTracker implements RootRevisionSource {
  private readonly states = new Map<string, RevisionState>();

  revision(root: string): RootRevision {
    const normalized = path.resolve(root);
    const state = this.ensure(normalized);
    return { token: String(state.generation), cacheable: state.cacheable };
  }

  bump(root: string): void {
    const state = this.ensure(path.resolve(root));
    state.generation += 1;
  }

  close(): void {
    for (const state of this.states.values()) state.watcher?.close();
    this.states.clear();
  }

  private ensure(root: string): RevisionState {
    const existing = this.states.get(root);
    if (existing) return existing;
    const state: RevisionState = { generation: 0, cacheable: false };
    this.states.set(root, state);
    try {
      state.watcher = watch(root, { recursive: true, persistent: false }, () => {
        state.generation += 1;
      });
      state.watcher.on("error", () => {
        state.cacheable = false;
        state.generation += 1;
      });
      state.cacheable = true;
    } catch {
      // Recursive fs.watch is not portable. Safety wins: disable reuse when
      // the host cannot provide a reliable root revision signal.
      state.cacheable = false;
    }
    return state;
  }
}

export class RevisionAwareFilesystemContextPort implements FilesystemContextPort {
  private readonly cache = new Map<string, readonly ContextEvidence[]>();

  constructor(
    private readonly delegate: FilesystemContextPort,
    private readonly revisions: RootRevisionSource,
    private readonly cacheLimit = DEFAULT_CACHE_LIMIT
  ) {}

  async search(request: TaskContextRequest): Promise<readonly ContextEvidence[]> {
    const before = this.revisions.revision(request.root);
    if (!before.cacheable) return this.delegate.search(request);
    const key = requestCacheKey(request, before.token);
    const hit = this.cache.get(key);
    if (hit) return markCacheHit(hit, "root-revision");

    const result = await this.delegate.search(request);
    const after = this.revisions.revision(request.root);
    if (after.cacheable && after.token === before.token) this.store(key, result);
    return result;
  }

  invalidate(root: string): void {
    evictRoot(this.cache, root);
  }

  private store(key: string, value: readonly ContextEvidence[]): void {
    this.cache.delete(key);
    this.cache.set(key, value);
    trimCache(this.cache, this.cacheLimit);
  }
}

export class RevisionAwareSemanticContextPort implements SemanticContextPort {
  private readonly cache = new Map<string, SemanticContextResult>();

  constructor(
    private readonly delegate: SemanticContextPort,
    private readonly revisions: RootRevisionSource,
    private readonly cacheLimit = DEFAULT_CACHE_LIMIT
  ) {}

  async context(request: TaskContextRequest): Promise<SemanticContextResult> {
    const before = this.revisions.revision(request.root);
    if (!before.cacheable) return this.delegate.context(request);
    const key = requestCacheKey(request, before.token);
    const hit = this.cache.get(key);
    if (hit) return { ...hit, evidence: markCacheHit(hit.evidence, "root-revision") };

    const result = await this.delegate.context(request);
    const after = this.revisions.revision(request.root);
    if (after.cacheable && after.token === before.token) this.store(key, result);
    return result;
  }

  diagnostics(root: string, changedFiles: readonly string[]): Promise<SemanticDiagnosticsResult> {
    if (!this.delegate.diagnostics) {
      return Promise.resolve({
        diagnostics: [],
        language: "unknown",
        engine: null,
        available: false,
        state: "unavailable",
        fresh: false,
        reason: "semantic diagnostics are not exposed by this runtime"
      });
    }
    return this.delegate.diagnostics(root, changedFiles);
  }

  invalidate(root: string): void {
    evictRoot(this.cache, root);
  }

  async close(): Promise<void> {
    await this.delegate.close?.();
  }

  private store(key: string, value: SemanticContextResult): void {
    this.cache.delete(key);
    this.cache.set(key, value);
    trimCache(this.cache, this.cacheLimit);
  }
}

function requestCacheKey(request: TaskContextRequest, revision: string): string {
  const root = path.resolve(request.root);
  const changed = [...(request.changedFiles ?? [])].map((file) => path.resolve(root, file)).sort();
  return [
    root,
    revision,
    request.intent ?? "",
    request.task.trim(),
    changed.join("\u001f"),
    String(request.budget?.maxItems ?? ""),
    String(request.budget?.maxChars ?? "")
  ].join("\u0000");
}

function markCacheHit(evidence: readonly ContextEvidence[], layer: string): readonly ContextEvidence[] {
  return evidence.map((item) => ({
    ...item,
    metadata: { ...(item.metadata ?? {}), cache_hit: true, cache_layer: layer }
  }));
}

function evictRoot<T>(cache: Map<string, T>, root: string): void {
  const prefix = `${path.resolve(root)}\u0000`;
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

function trimCache<T>(cache: Map<string, T>, limit: number): void {
  while (cache.size > limit) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}
