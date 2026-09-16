import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

import type { ContextEvidence, TaskContextRequest } from "../../domain/task-context.js";
import type { FilesystemContextPort } from "../../ports/context-providers.js";

export interface CommandResult {
  stdout: string;
}

export interface SearchCommandRunOptions {
  maxMatches?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

export interface SearchCommandRunner {
  run(
    command: string,
    args: readonly string[],
    cwd: string,
    options?: SearchCommandRunOptions
  ): Promise<CommandResult>;
}

export interface RipgrepFilesystemContextAdapterOptions {
  command?: string;
  runner?: SearchCommandRunner;
}

export class RipgrepFilesystemContextAdapter implements FilesystemContextPort {
  private readonly command: string;
  private readonly runner: SearchCommandRunner;

  constructor(options: RipgrepFilesystemContextAdapterOptions = {}) {
    this.command = options.command ?? "rg";
    this.runner = options.runner ?? new StreamingSearchCommandRunner();
  }

  async search(request: TaskContextRequest): Promise<readonly ContextEvidence[]> {
    const terms = extractSearchTerms(request.task);
    if (terms.length === 0) return [];

    const root = path.resolve(request.root);
    const maxItems = Math.max(1, Math.min(100, request.budget?.maxItems ?? 20));
    const args = [
      "--json",
      "--ignore-case",
      "--hidden",
      "--glob", "!.git/**",
      "--glob", "!.codegraph/**",
      "--glob", "!node_modules/**",
      ...terms.flatMap((term) => ["-e", term]),
      "."
    ];
    const maxCharsPerItem = request.budget?.maxChars
      ? Math.max(300, Math.floor(request.budget.maxChars / maxItems))
      : 4_000;
    const maxOutputBytes = Math.max(
      64 * 1024,
      Math.min(4 * 1024 * 1024, maxItems * (maxCharsPerItem + 2_048))
    );
    const { stdout } = await this.runner.run(this.command, args, root, {
      maxMatches: maxItems,
      maxOutputBytes,
      timeoutMs: 30_000
    });

    return parseRipgrepJson(stdout, root, maxItems, maxCharsPerItem);
  }
}

export interface StreamingSearchCommandRunnerOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export class StreamingSearchCommandRunner implements SearchCommandRunner {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;

  constructor(options: StreamingSearchCommandRunnerOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.platform = options.platform ?? process.platform;
  }

  async run(
    command: string,
    args: readonly string[],
    cwd: string,
    options: SearchCommandRunOptions = {}
  ): Promise<CommandResult> {
    await assertSearchDirectory(cwd);
    const candidates = buildRipgrepCommandCandidates(command, this.environment, this.platform);
    let lastNotFoundError: unknown;

    for (const candidate of candidates) {
      try {
        return await runStreamingCommand(candidate, args, cwd, this.environment, options);
      } catch (error) {
        if (!isExecutableNotFound(error)) throw error;
        lastNotFoundError = error;
      }
    }

    throw new Error(
      `ripgrep executable was not found. Install ripgrep or set LCA_RG_PATH to its absolute path. Tried: ${candidates.join(", ")}`,
      { cause: lastNotFoundError }
    );
  }
}

async function assertSearchDirectory(cwd: string): Promise<void> {
  const resolved = path.resolve(cwd);
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
      throw new Error("Workspace search directory does not exist: " + resolved);
    }
    throw error;
  }
  if (!info.isDirectory()) {
    throw new Error("Workspace search path is not a directory: " + resolved);
  }
}

export function buildRipgrepCommandCandidates(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): readonly string[] {
  if (!isDefaultRipgrepCommand(command)) return [command];

  const executable = platform === "win32" ? "rg.exe" : "rg";
  const configured = environment.LCA_RG_PATH?.trim() || environment.RIPGREP_PATH?.trim();
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const pathCandidates = (environment.PATH ?? "")
    .split(pathDelimiter)
    .map((directory) => directory.trim())
    .filter(Boolean)
    .map((directory) => pathApi.join(directory, executable));
  const commonCandidates = platform === "win32"
    ? []
    : ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg", "/snap/bin/rg"];

  return uniqueNonEmpty([configured, command, ...pathCandidates, ...commonCandidates]);
}

function runStreamingCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  options: SearchCommandRunOptions
): Promise<CommandResult> {
  const maxMatches = Math.max(1, options.maxMatches ?? 20);
  const maxOutputBytes = Math.max(32 * 1024, options.maxOutputBytes ?? 4 * 1024 * 1024);
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 30_000);

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let pending = "";
    let stdoutBytes = 0;
    let matchCount = 0;
    let stoppedEarly = false;
    let timedOut = false;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      callback();
    };

    const stopEarly = (): void => {
      if (stoppedEarly) return;
      stoppedEarly = true;
      pending = "";
      if (!child.killed) child.kill();
    };

    const appendLine = (line: string): void => {
      if (stoppedEarly) return;
      const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
      const output = `${normalizedLine}\n`;
      const outputBytes = Buffer.byteLength(output);
      if (stdoutBytes + outputBytes > maxOutputBytes) {
        stopEarly();
        return;
      }

      stdout += output;
      stdoutBytes += outputBytes;
      if (isRipgrepMatchEvent(normalizedLine)) {
        matchCount += 1;
        if (matchCount >= maxMatches) stopEarly();
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stoppedEarly) return;
      pending += chunk;
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        appendLine(pending.slice(0, newlineIndex));
        pending = stoppedEarly ? "" : pending.slice(newlineIndex + 1);
        if (stoppedEarly) break;
        newlineIndex = pending.indexOf("\n");
      }
      if (!stoppedEarly && Buffer.byteLength(pending) > maxOutputBytes) stopEarly();
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk.slice(0, 64 * 1024 - stderr.length);
    });

    child.once("error", (error) => settle(() => reject(error)));
    child.once("close", (code, signal) => {
      if (!stoppedEarly && pending) appendLine(pending);
      settle(() => {
        if (timedOut) {
          reject(new Error(`ripgrep timed out after ${timeoutMs}ms while searching ${cwd}`));
          return;
        }
        if (stoppedEarly || code === 0 || code === 1) {
          resolve({ stdout });
          return;
        }
        const detail = stderr.trim() || `terminated by ${signal ?? "unknown signal"}`;
        reject(new Error(`ripgrep exited with code ${code ?? "null"}: ${detail}`));
      });
    });

    timeout = setTimeout(() => {
      timedOut = true;
      if (!child.killed) child.kill();
    }, timeoutMs);
  });
}

function isRipgrepMatchEvent(line: string): boolean {
  if (!line.includes('"type":"match"') && !line.includes('"type": "match"')) return false;
  try {
    return asRecord(JSON.parse(line)).type === "match";
  } catch {
    return false;
  }
}

function isDefaultRipgrepCommand(command: string): boolean {
  return command === "rg" || command === "rg.exe";
}

function isExecutableNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT");
}

function uniqueNonEmpty(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))];
}

function parseRipgrepJson(
  stdout: string,
  root: string,
  maxItems: number,
  maxCharsPerItem: number
): readonly ContextEvidence[] {
  const evidence: ContextEvidence[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(event);
    if (record.type !== "match") continue;
    const data = asRecord(record.data);
    const relativePath = textValue(asRecord(data.path)) ?? "";
    const lineText = textValue(asRecord(data.lines))?.trimEnd() ?? "";
    const lineNumber = typeof data.line_number === "number" ? data.line_number : undefined;
    if (!relativePath || !lineText) continue;

    evidence.push({
      id: `filesystem-${relativePath}:${lineNumber ?? 0}`,
      provider: "filesystem",
      kind: "text",
      title: `${relativePath}${lineNumber ? `:${lineNumber}` : ""}`,
      content: lineText.slice(0, maxCharsPerItem),
      path: path.resolve(root, relativePath),
      score: 100,
      metadata: {
        line: lineNumber ?? null,
        engine: "ripgrep"
      }
    });
    if (evidence.length >= maxItems) break;
  }
  return evidence;
}

function extractSearchTerms(task: string): readonly string[] {
  const stopWords = new Set([
    "about", "after", "before", "could", "from", "have", "into", "should", "that", "this", "what", "when", "where", "which", "with",
    "anh", "cai", "cho", "cua", "duoc", "giup", "khong", "lam", "nay", "nhung", "sao", "the", "tim", "trong", "va", "voi"
  ]);
  const unique = new Set<string>();
  for (const token of task.toLowerCase().match(/[\p{L}\p{N}_.$/-]+/gu) ?? []) {
    const normalized = token.replace(/^[-./$]+|[-./$]+$/g, "");
    if (normalized.length < 3 || stopWords.has(normalized)) continue;
    unique.add(normalized);
    if (unique.size >= 8) break;
  }
  return [...unique];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function textValue(value: Record<string, unknown>): string | undefined {
  return typeof value.text === "string" ? value.text : undefined;
}
