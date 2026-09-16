import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ContextEvidence, TaskContextRequest } from "../../domain/task-context.js";
import type { LspClientLike, StdioLspClientOptions } from "../../infrastructure/lsp/stdio-lsp-client.js";
import type { SemanticEngine, SemanticEngineResult } from "./semantic-context-adapter.js";
import { LspSymbolSession } from "./lsp-symbol-session.js";

const ENGINE_NAME = "dart-analysis-server-lsp";

export interface DartSemanticEngineOptions {
  resolveDartExecutable?: (root: string) => Promise<string | null>;
  createClient?: (options: StdioLspClientOptions) => LspClientLike;
  queryTimeoutMs?: number;
  warmupTimeoutMs?: number;
  readyQuietPeriodMs?: number;
}

export class DartSemanticEngine implements SemanticEngine {
  readonly language = "dart" as const;
  readonly name = ENGINE_NAME;
  private readonly sessions = new Map<string, LspSymbolSession>();

  constructor(private readonly options: DartSemanticEngineOptions = {}) {}

  async context(request: TaskContextRequest): Promise<readonly ContextEvidence[] | SemanticEngineResult> {
    const root = path.resolve(request.root);
    let session = this.sessions.get(root);
    if (!session) {
      const executable = await (this.options.resolveDartExecutable ?? resolveDartExecutable)(root);
      if (!executable) {
        return {
          evidence: [],
          state: "unavailable",
          reason: "Dart SDK was not found. Configure DART_BIN, FLUTTER_ROOT, a project .fvm/flutter_sdk, or put dart on PATH."
        };
      }
      session = new LspSymbolSession({
        language: "dart",
        engineName: ENGINE_NAME,
        root,
        command: executable,
        args: ["language-server", "--protocol=lsp", "--client-id=lca", "--client-version=4.4.0-pro"],
        ...(this.options.createClient ? { createClient: this.options.createClient } : {}),
        readiness: dartReadiness,
        queryTimeoutMs: this.options.queryTimeoutMs ?? 900,
        warmupTimeoutMs: this.options.warmupTimeoutMs ?? 60_000,
        readyQuietPeriodMs: this.options.readyQuietPeriodMs ?? 1_000
      });
      this.sessions.set(root, session);
    }
    return session.context(request);
  }

  async close(): Promise<void> {
    const settled = await Promise.allSettled([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
    const errors = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (errors.length > 0) throw new AggregateError(errors.map((result) => result.reason), "Dart semantic sessions failed to close.");
  }
}

export async function resolveDartExecutable(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir()
): Promise<string | null> {
  const executable = process.platform === "win32" ? "dart.exe" : "dart";
  const candidates: string[] = [];
  const add = (value: string | undefined) => {
    if (value) candidates.push(path.resolve(value));
  };

  add(environment.DART_BIN);
  add(path.join(root, ".fvm", "flutter_sdk", "bin", executable));
  if (environment.FLUTTER_ROOT) add(path.join(environment.FLUTTER_ROOT, "bin", executable));
  if (environment.FVM_FLUTTER_ROOT) add(path.join(environment.FVM_FLUTTER_ROOT, "bin", executable));

  for (const directory of String(environment.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    add(path.join(directory, executable));
  }

  const fvmVersion = await readFvmVersion(root);
  if (fvmVersion) {
    add(path.join(homeDirectory, "fvm", "versions", fvmVersion, "bin", executable));
    add(path.join(homeDirectory, ".fvm", "versions", fvmVersion, "bin", executable));
  }
  add(path.join(homeDirectory, "fvm", "default", "bin", executable));
  add(path.join(homeDirectory, ".fvm", "default", "bin", executable));
  add(path.join(homeDirectory, "Library", "flutter", "bin", executable));

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

function dartReadiness(method: string, params: unknown): "warming" | "ready" | undefined {
  if (method !== "$/progress") return undefined;
  const record = asRecord(params);
  if (String(record.token ?? "") !== "ANALYZING") return undefined;
  const value = asRecord(record.value);
  if (value.kind === "begin" || value.kind === "report") return "warming";
  if (value.kind === "end") return "ready";
  return undefined;
}

async function readFvmVersion(root: string): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(path.join(root, ".fvmrc"), "utf8")) as { flutter?: unknown };
    return typeof value.flutter === "string" && value.flutter.trim() ? value.flutter.trim() : null;
  } catch {
    try {
      const raw = (await readFile(path.join(root, ".fvm", "version"), "utf8")).trim();
      return raw || null;
    } catch {
      return null;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
