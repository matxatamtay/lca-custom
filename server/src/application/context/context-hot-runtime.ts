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
const MANUAL_BUMP_RECENT_EVENT_MS = 2_000;
const MANUAL_BUMP_SUPPRESS_EVENT_MS = 250;

export interface RootRevision {
  token: string;
  cacheable: boolean;
}

export interface RootRevisionSource {
  revision(root: string): RootRevision;
  bump(root: string, changedFiles?: readonly string[]): void;
  close?(): void;
}

export interface WorkspaceRevisionTrackerOptions {
  ignore?: (root: string, filename: string | Buffer | null) => boolean;
}

interface RevisionState {
  generation: number;
  cacheable: boolean;
  watcher?: FSWatcher;
  recentEvents: Map<string, number>;
  suppressUntil: Map<string, number>;
}

export class WorkspaceRevisionTracker implements RootRevisionSource {
  private readonly states = new Map<string, RevisionState>();

  constructor(private readonly options: WorkspaceRevisionTrackerOptions = {}) {}

  revision(root: string): RootRevision {
    const normalized = path.resolve(root);
    const state = this.ensure(normalized);
    return { token: String(state.generation), cacheable: state.cacheable };
  }

  bump(root: string, changedFiles: readonly string[] = []): void {
    const normalizedRoot = path.resolve(root);
    const state = this.ensure(normalizedRoot);
    if (changedFiles.length === 0) {
      state.generation += 1;
      return;
    }

    const now = Date.now();
    const trackedPaths = revisionEventPaths(normalizedRoot, changedFiles);
    pruneRevisionEventMaps(state, now);
    const consumedRecent = trackedPaths.some((eventPath) => {
      const seenAt = state.recentEvents.get(eventPath);
      return seenAt !== undefined && now - seenAt <= MANUAL_BUMP_RECENT_EVENT_MS;
    });
    if (consumedRecent) {
      for (const eventPath of trackedPaths) state.recentEvents.delete(eventPath);
    } else {
      state.generation += 1;
    }
    const suppressUntil = now + MANUAL_BUMP_SUPPRESS_EVENT_MS;
    for (const eventPath of trackedPaths) state.suppressUntil.set(eventPath, suppressUntil);
  }

  close(): void {
    for (const state of this.states.values()) state.watcher?.close();
    this.states.clear();
  }

  private ensure(root: string): RevisionState {
    const existing = this.states.get(root);
    if (existing) return existing;
    const state: RevisionState = {
      generation: 0,
      cacheable: false,
      recentEvents: new Map(),
      suppressUntil: new Map()
    };
    this.states.set(root, state);
    try {
      state.watcher = watch(root, { recursive: true, persistent: false }, (_eventType, filename) => {
        const normalizedFilename = normalizeRevisionFilename(filename);
        // macOS recursive fs.watch emits a synthetic root-basename "change"
        // alongside the useful descendant event. Counting both creates false
        // revision churn, especially for ignored runtime/state writes.
        if (normalizedFilename === path.basename(root)) return;
        if (shouldIgnoreRevisionEvent(normalizedFilename)) return;
        if (this.options.ignore?.(root, normalizedFilename)) return;
        const now = Date.now();
        pruneRevisionEventMaps(state, now);
        const suppressUntil = state.suppressUntil.get(normalizedFilename);
        if (suppressUntil !== undefined && suppressUntil >= now) return;
        state.generation += 1;
        state.recentEvents.set(normalizedFilename, now);
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
  private readonly inFlight = new Map<string, Promise<readonly ContextEvidence[]>>();

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

    const pending = this.inFlight.get(key);
    if (pending) return markCacheHit(await pending, "root-revision-inflight");

    const operation = this.delegate.search(request);
    this.inFlight.set(key, operation);
    try {
      const result = await operation;
      const after = this.revisions.revision(request.root);
      if (after.cacheable && after.token === before.token) this.store(key, result);
      return markCacheMiss(result, "root-revision");
    } finally {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }
  }

  invalidate(root: string): void {
    evictRoot(this.cache, root);
    evictRoot(this.inFlight, root);
  }

  private store(key: string, value: readonly ContextEvidence[]): void {
    this.cache.delete(key);
    this.cache.set(key, value);
    trimCache(this.cache, this.cacheLimit);
  }
}

export class RevisionAwareSemanticContextPort implements SemanticContextPort {
  private readonly cache = new Map<string, SemanticContextResult>();
  private readonly inFlight = new Map<string, Promise<SemanticContextResult>>();

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

    const pending = this.inFlight.get(key);
    if (pending) {
      const result = await pending;
      return { ...result, evidence: markCacheHit(result.evidence, "root-revision-inflight") };
    }

    const operation = this.delegate.context(request);
    this.inFlight.set(key, operation);
    try {
      const result = await operation;
      const after = this.revisions.revision(request.root);
      if (after.cacheable && after.token === before.token) this.store(key, result);
      return { ...result, evidence: markCacheMiss(result.evidence, "root-revision") };
    } finally {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }
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
    evictRoot(this.inFlight, root);
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
    request.task.trim().replace(/\s+/g, " "),
    changed.join("\u001f"),
    String(request.budget?.maxItems ?? ""),
    String(request.budget?.maxChars ?? "")
  ].join("\u0000");
}

export function shouldIgnoreRevisionEvent(filename: string | Buffer | null): boolean {
  const normalized = normalizeRevisionFilename(filename);
  if (!normalized) return false;
  if (normalized === ".agent") return true;
  return /(?:^|\/)(?:\.git|\.codegraph|node_modules|\.agent\/state|runtime\/agentmemory)(?:\/|$)/.test(normalized);
}

function normalizeRevisionFilename(filename: string | Buffer | null): string {
  return String(filename ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
}

function revisionEventPaths(root: string, changedFiles: readonly string[]): readonly string[] {
  const paths = new Set<string>();
  for (const file of changedFiles) {
    const absolute = path.resolve(root, file);
    const relative = normalizeRevisionFilename(path.relative(root, absolute));
    if (!relative || relative === ".." || relative.startsWith("../")) continue;
    paths.add(relative);
    let parent = path.posix.dirname(relative);
    while (parent && parent !== ".") {
      paths.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return [...paths];
}

function pruneRevisionEventMaps(state: RevisionState, now: number): void {
  for (const [eventPath, seenAt] of state.recentEvents) {
    if (now - seenAt > MANUAL_BUMP_RECENT_EVENT_MS) state.recentEvents.delete(eventPath);
  }
  for (const [eventPath, until] of state.suppressUntil) {
    if (until < now) state.suppressUntil.delete(eventPath);
  }
}

function markCacheHit(evidence: readonly ContextEvidence[], layer: string): readonly ContextEvidence[] {
  return evidence.map((item) => ({
    ...item,
    metadata: { ...(item.metadata ?? {}), cache_hit: true, cache_layer: layer }
  }));
}

function markCacheMiss(evidence: readonly ContextEvidence[], layer: string): readonly ContextEvidence[] {
  return evidence.map((item) => ({
    ...item,
    metadata: { ...(item.metadata ?? {}), cache_hit: false, cache_layer: layer }
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
