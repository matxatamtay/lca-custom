import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface ConversationRuntimeState {
  primaryRoot: string;
  discoveryRoots: readonly string[];
  conversationId?: string;
  sessionId?: string;
  runner: string;
  profile?: string;
  isolation: "shared" | "worktree";
  networkAccess: boolean;
  correlationId: string;
}

export interface ConversationRuntimeContextOptions {
  primaryRoot: string;
  roots: readonly string[];
  runner?: string;
  profile?: string;
  isolation?: "shared" | "worktree";
  networkAccess?: boolean;
}

export type ConversationRuntimeSelection = string | Partial<ConversationRuntimeState> | undefined;

export class ConversationRuntimeContext {
  readonly #fallback: ConversationRuntimeState;
  readonly #storage = new AsyncLocalStorage<ConversationRuntimeState>();

  constructor(options: ConversationRuntimeContextOptions) {
    const primaryRoot = path.resolve(options.primaryRoot);
    const roots = uniquePaths(options.roots);
    if (!roots.some((root) => samePath(root, primaryRoot))) {
      throw new Error("Conversation runtime roots must include the fallback primary root.");
    }
    this.#fallback = Object.freeze({
      primaryRoot,
      discoveryRoots: Object.freeze(roots),
      runner: options.runner?.trim() || "codex",
      ...(options.profile?.trim() ? { profile: options.profile.trim() } : {}),
      isolation: options.isolation ?? "worktree",
      networkAccess: options.networkAccess !== false,
      correlationId: "runtime-default"
    });
  }

  run<T>(selection: ConversationRuntimeSelection, callback: () => T): T {
    if (selection === undefined || selection === null || selection === "") return callback();
    const current = this.current();
    const patch = typeof selection === "string" ? { primaryRoot: selection } : selection;
    const changesPrimaryRoot = typeof patch.primaryRoot === "string" && Boolean(patch.primaryRoot.trim());
    const primaryRoot = patch.primaryRoot ? path.resolve(patch.primaryRoot) : current.primaryRoot;
    const state: ConversationRuntimeState = {
      ...current,
      ...patch,
      primaryRoot,
      discoveryRoots: patch.discoveryRoots
        ? uniquePaths(patch.discoveryRoots)
        : changesPrimaryRoot ? [primaryRoot] : current.discoveryRoots,
      runner: patch.runner?.trim() || current.runner,
      isolation: patch.isolation ?? current.isolation,
      networkAccess: patch.networkAccess ?? current.networkAccess,
      correlationId: patch.correlationId?.trim() || current.correlationId || randomUUID()
    };
    return this.#storage.run(state, callback);
  }

  current(): ConversationRuntimeState {
    return this.#storage.getStore() ?? this.#fallback;
  }

  normalize(project: unknown): string | undefined {
    return typeof project === "string" && project.trim() ? path.resolve(project.trim()) : undefined;
  }

  scopedPrimaryRoot(): string | undefined {
    return this.#storage.getStore()?.primaryRoot;
  }

  primaryRoot(): string { return this.current().primaryRoot; }
  discoveryRoots(): readonly string[] { return this.current().discoveryRoots; }
  isScoped(): boolean { return Boolean(this.#storage.getStore()); }
}

function uniquePaths(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.map((value) => path.resolve(value)).filter((value) => {
    const key = comparablePath(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
