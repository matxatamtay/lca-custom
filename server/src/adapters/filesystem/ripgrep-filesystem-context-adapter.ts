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
    const maxCandidates = Math.max(maxItems, Math.min(500, maxItems * 8));
    const args = [
      "--json",
      "--ignore-case",
      "--hidden",
      ...defaultIgnoreGlobs(request.task).flatMap((glob) => ["--glob", glob]),
      ...terms.flatMap((term) => ["-e", term]),
      "."
    ];
    const { stdout } = await this.runner.run(this.command, args, root);
    const maxCharsPerItem = request.budget?.maxChars
      ? Math.max(300, Math.floor(request.budget.maxChars / maxItems))
      : 4_000;

    return [...parseRipgrepJson(stdout, root, maxCandidates, maxCharsPerItem, terms, request.changedFiles)]
      .sort(compareFilesystemEvidence)
      .slice(0, maxItems);
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
  maxCandidates: number,
  maxCharsPerItem: number,
  terms: readonly string[],
  changedFiles: readonly string[] | undefined
): readonly ContextEvidence[] {
  const evidence: ContextEvidence[] = [];
  const changed = new Set((changedFiles ?? []).map((value) => normalizePathForMatch(path.resolve(root, value))));
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
    const absolutePath = path.resolve(root, relativePath);
    const score = filesystemEvidenceScore(relativePath, lineText, terms, changed.has(normalizePathForMatch(absolutePath)));

    evidence.push({
      id: `filesystem-${relativePath}:${lineNumber ?? 0}`,
      provider: "filesystem",
      kind: "text",
      title: `${relativePath}${lineNumber ? `:${lineNumber}` : ""}`,
      content: lineText.slice(0, maxCharsPerItem),
      path: absolutePath,
      score,
      metadata: {
        line: lineNumber ?? null,
        engine: "ripgrep",
        relevance_score: score
      }
    });
    if (evidence.length >= maxCandidates) break;
  }
  return evidence;
}

function defaultIgnoreGlobs(task: string): readonly string[] {
  const globs = [
    "!.git/**",
    "!.codegraph/**",
    "!node_modules/**",
    "!dist/**",
    "!build/**",
    "!coverage/**",
    "!.next/**",
    "!.turbo/**",
    "!target/**",
    "!vendor/**",
    "!**/*.min.js",
    "!**/*.min.css"
  ];
  if (!/\b(license|licensing|copyright|gpl|agpl|mit|apache|copyleft)\b/i.test(task)) {
    globs.push("!LICENSE", "!LICENSE.*", "!COPYING", "!COPYING.*");
  }
  return globs;
}

function filesystemEvidenceScore(
  relativePath: string,
  lineText: string,
  terms: readonly string[],
  changed: boolean
): number {
  const normalizedPath = relativePath.toLowerCase();
  const normalizedLine = lineText.toLowerCase();
  let score = 100;
  let matchedTerms = 0;
  for (const term of terms) {
    const normalized = term.toLowerCase();
    if (normalizedLine.includes(normalized)) {
      score += 18;
      matchedTerms += 1;
    }
    if (normalizedPath.includes(normalized)) score += 24;
  }
  score += Math.min(36, matchedTerms * 6);
  if (changed) score += 45;
  if (isLikelySourcePath(normalizedPath)) score += 12;
  if (/\/(test|tests|__tests__)\/|\.(test|spec)\.[^.]+$/i.test(normalizedPath)) score += 8;
  if (/\/(docs?|examples?|fixtures?)\//i.test(`/${normalizedPath}`)) score -= 8;
  if (/\.(md|txt|lock)$/i.test(normalizedPath)) score -= 12;
  return score;
}

function compareFilesystemEvidence(left: ContextEvidence, right: ContextEvidence): number {
  const score = (right.score ?? 0) - (left.score ?? 0);
  if (score !== 0) return score;
  return left.id.localeCompare(right.id);
}

function isLikelySourcePath(value: string): boolean {
  return /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|kts|dart|swift|cs|cpp|cc|c|h|hpp|rb|php|vue|svelte)$/i.test(value);
}

function normalizePathForMatch(value: string): string {
  return path.normalize(value).replaceAll("\\", "/").toLowerCase();
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
