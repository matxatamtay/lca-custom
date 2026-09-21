import { createHash } from "node:crypto";
import { access, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ContextEvidence, TaskContextRequest } from "../../domain/task-context.js";
import type { LspClientLike, StdioLspClientOptions } from "../../infrastructure/lsp/stdio-lsp-client.js";
import type { SemanticDiagnosticsResult } from "../../ports/context-providers.js";
import type { SemanticEngine, SemanticEngineResult } from "./semantic-context-adapter.js";
import { LspSymbolSession } from "./lsp-symbol-session.js";

const ENGINE_NAME = "eclipse-jdt-ls";

export interface JavaSemanticEngineOptions {
  resolveJdtLsExecutable?: (root: string) => Promise<string | null>;
  createClient?: (options: StdioLspClientOptions) => LspClientLike;
  queryTimeoutMs?: number;
  warmupTimeoutMs?: number;
  warmupProbeTimeoutMs?: number;
  readyQuietPeriodMs?: number;
}

export class JavaSemanticEngine implements SemanticEngine {
  readonly language = "java" as const;
  readonly name = ENGINE_NAME;
  private readonly sessions = new Map<string, LspSymbolSession>();

  constructor(private readonly options: JavaSemanticEngineOptions = {}) {}

  async context(request: TaskContextRequest): Promise<readonly ContextEvidence[] | SemanticEngineResult> {
    const root = path.resolve(request.root);
    let session = this.sessions.get(root);
    if (!session) {
      const executable = await (this.options.resolveJdtLsExecutable ?? resolveJdtLsExecutable)(root);
      if (!executable) {
        return {
          evidence: [],
          state: "unavailable",
          reason: "Eclipse JDT Language Server was not found. Configure JDTLS_BIN or install the isolated LCA JDT LS runtime; CodeGraph remains active in parallel."
        };
      }
      const dataDirectory = await javaWorkspaceDataDirectory(root);
      session = new LspSymbolSession({
        language: "java",
        engineName: ENGINE_NAME,
        root,
        command: executable,
        args: ["-data", dataDirectory],
        ...(this.options.createClient ? { createClient: this.options.createClient } : {}),
        readiness: javaReadiness,
        queryTimeoutMs: this.options.queryTimeoutMs ?? 1_200,
        warmupTimeoutMs: this.options.warmupTimeoutMs ?? 300_000,
        warmupProbeTimeoutMs: this.options.warmupProbeTimeoutMs ?? 15_000,
        readyQuietPeriodMs: this.options.readyQuietPeriodMs ?? 1_500
      });
      this.sessions.set(root, session);
    }
    return session.context(request);
  }

  async diagnostics(root: string, changedFiles: readonly string[]): Promise<SemanticDiagnosticsResult> {
    const normalizedRoot = path.resolve(root);
    if (!this.sessions.has(normalizedRoot)) {
      await this.context({ task: "post-edit diagnostics", root: normalizedRoot, changedFiles });
    }
    const session = this.sessions.get(normalizedRoot);
    if (!session) {
      return {
        diagnostics: [], language: "java", engine: ENGINE_NAME, available: false,
        state: "unavailable", fresh: false, reason: "Java semantic session is unavailable."
      };
    }
    return session.diagnostics(changedFiles);
  }

  async close(): Promise<void> {
    const settled = await Promise.allSettled([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
    const errors = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (errors.length > 0) throw new AggregateError(errors.map((result) => result.reason), "Java semantic sessions failed to close.");
  }
}

export async function resolveJdtLsExecutable(
  _root: string,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
  managedRuntimeDirectory = defaultManagedJdtLsDirectory()
): Promise<string | null> {
  const executable = process.platform === "win32" ? "jdtls.bat" : "jdtls";
  const candidates: string[] = [];
  const add = (value: string | undefined) => {
    if (value) candidates.push(path.resolve(value));
  };

  add(environment.JDTLS_BIN);
  for (const candidate of await managedJdtLsCandidates(managedRuntimeDirectory, executable)) add(candidate);
  for (const directory of String(environment.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    add(path.join(directory, executable));
  }
  add(path.join(homeDirectory, ".local", "bin", executable));
  add(path.join(homeDirectory, "bin", executable));
  if (process.platform === "darwin") {
    add("/opt/homebrew/bin/jdtls");
    add("/usr/local/bin/jdtls");
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function javaWorkspaceDataDirectory(root: string): Promise<string> {
  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const key = createHash("sha256").update(normalizePath(root)).digest("hex").slice(0, 16);
  const directory = path.join(serverRoot, "data", "semantic", "jdtls", key);
  await mkdir(directory, { recursive: true });
  return directory;
}

function defaultManagedJdtLsDirectory(): string {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  return path.join(repoRoot, "runtime", "jdtls");
}

function normalizePath(value: string): string {
  const normalized = path.resolve(value).replace(/\\\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function managedJdtLsCandidates(baseDirectory: string, executable: string): Promise<string[]> {
  try {
    const entries = await readdir(baseDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((version) => path.join(baseDirectory, version, "bin", executable));
  } catch {
    return [];
  }
}

export function javaReadiness(method: string, params: unknown): "warming" | "ready" | undefined {
  if (method === "language/status") {
    const type = String(asRecord(params).type ?? "").toLowerCase();
    if (type === "started" || type === "serviceready") return "ready";
    if (type === "starting" || type === "message") return "warming";
  }
  if (method === "$/progress") {
    const value = asRecord(asRecord(params).value);
    const description = `${String(value.title ?? "")} ${String(value.message ?? "")}`.toLowerCase();
    // Source/javadoc downloads can continue long after the workspace symbol index is usable.
    // They must not hold semantic coverage in a perpetual warming state.
    if (description.includes("download sources and javadoc")) return undefined;
    if (value.kind === "begin" || value.kind === "report") return "warming";
    if (value.kind === "end") return "ready";
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
