import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

interface ConversationProjectState {
  primaryRoot: string;
}

export interface ConversationProjectScopeOptions {
  primaryRoot: string;
  roots: readonly string[];
}

export class ConversationProjectScope {
  readonly #fallbackPrimaryRoot: string;
  readonly #roots: readonly string[];
  readonly #storage = new AsyncLocalStorage<ConversationProjectState>();

  constructor(options: ConversationProjectScopeOptions) {
    this.#fallbackPrimaryRoot = path.resolve(options.primaryRoot);
    this.#roots = Object.freeze(uniquePaths(options.roots));
    if (!this.#roots.some((root) => samePath(root, this.#fallbackPrimaryRoot))) {
      throw new Error("Conversation project roots must include the fallback primary root.");
    }
  }

  run<T>(project: unknown, callback: () => T): T {
    const primaryRoot = this.normalize(project);
    if (!primaryRoot) return callback();
    return this.#storage.run({ primaryRoot }, callback);
  }

  normalize(project: unknown): string | undefined {
    if (typeof project !== "string" || !project.trim()) return undefined;
    return path.resolve(project.trim());
  }

  scopedPrimaryRoot(): string | undefined {
    return this.#storage.getStore()?.primaryRoot;
  }

  primaryRoot(): string {
    return this.scopedPrimaryRoot() ?? this.#fallbackPrimaryRoot;
  }

  discoveryRoots(): readonly string[] {
    const scoped = this.scopedPrimaryRoot();
    return scoped ? [scoped] : this.#roots;
  }

  isScoped(): boolean {
    return Boolean(this.scopedPrimaryRoot());
  }
}

function uniquePaths(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const resolved = path.resolve(value);
    const key = comparablePath(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
