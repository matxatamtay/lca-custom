import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { ContextEvidence, TaskContextRequest } from "../../domain/task-context.js";
import type { FilesystemContextPort } from "../../ports/context-providers.js";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
}

export interface SearchCommandRunner {
  run(command: string, args: readonly string[], cwd: string): Promise<CommandResult>;
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
    this.runner = options.runner ?? new ExecFileSearchCommandRunner();
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
    const { stdout } = await this.runner.run(this.command, args, root);
    const maxCharsPerItem = request.budget?.maxChars
      ? Math.max(300, Math.floor(request.budget.maxChars / maxItems))
      : 4_000;

    return parseRipgrepJson(stdout, root, maxItems, maxCharsPerItem);
  }
}

class ExecFileSearchCommandRunner implements SearchCommandRunner {
  async run(command: string, args: readonly string[], cwd: string): Promise<CommandResult> {
    try {
      const result = await execFileAsync(command, [...args], {
        cwd,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true
      });
      return { stdout: result.stdout };
    } catch (error) {
      const exitCode = asExitCode(error);
      if (exitCode === 1) return { stdout: "" };
      throw error;
    }
  }
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

function asExitCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}
