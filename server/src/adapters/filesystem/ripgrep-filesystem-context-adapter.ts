import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
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
    const search = buildSearchProfile(request);
    if (search.terms.length === 0) return [];

    const root = path.resolve(request.root);
    const maxItems = Math.max(1, Math.min(100, request.budget?.maxItems ?? 20));
    const maxCharsPerItem = request.budget?.maxChars
      ? Math.max(300, Math.floor(request.budget.maxChars / maxItems))
      : 4_000;
    const concreteTerms = search.terms.filter((term) => term.kind !== "keyword");
    const keywordTerms = search.terms.filter((term) => term.kind === "keyword");

    const runTerms = async (terms: readonly SearchTerm[]): Promise<readonly ContextEvidence[]> => {
      if (terms.length === 0) return [];
      const candidateLimit = Math.max(maxItems, Math.min(400, maxItems * 8));
      const args = [
        "--json",
        "--ignore-case",
        "--fixed-strings",
        "--hidden",
        "--glob", "!.git/**",
        "--glob", "!.codegraph/**",
        "--glob", "!node_modules/**",
        ...terms.flatMap((term) => ["-e", term.value]),
        "."
      ];
      const maxOutputBytes = Math.max(
        64 * 1024,
        Math.min(4 * 1024 * 1024, candidateLimit * (maxCharsPerItem + 2_048))
      );
      const { stdout } = await this.runner.run(this.command, args, root, {
        maxMatches: candidateLimit,
        maxOutputBytes,
        timeoutMs: 30_000
      });
      const parsed = parseRipgrepJson(stdout, root, maxItems, maxCharsPerItem, search, request.changedFiles ?? []);
      return enrichSourceSlices(parsed, Math.min(6, maxItems), Math.max(500, Math.min(1_800, maxCharsPerItem)));
    };

    if (concreteTerms.length > 0) {
      const concreteEvidence = await runTerms(concreteTerms);
      if (concreteEvidence.length > 0 || keywordTerms.length === 0) return concreteEvidence;
    }

    return runTerms(keywordTerms);
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

type SearchTermKind = "symbol" | "path" | "keyword";

interface SearchTerm {
  value: string;
  normalized: string;
  kind: SearchTermKind;
}

interface SearchProfile {
  terms: readonly SearchTerm[];
  hasConcreteTerms: boolean;
  intent: NonNullable<TaskContextRequest["intent"]> | "unknown";
  taskLower: string;
}

function parseRipgrepJson(
  stdout: string,
  root: string,
  maxItems: number,
  maxCharsPerItem: number,
  search: SearchProfile,
  changedFiles: readonly string[]
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

    const rerank = scoreFilesystemMatch(relativePath, lineText, search, changedFiles);
    evidence.push({
      id: `filesystem-${relativePath}:${lineNumber ?? 0}`,
      provider: "filesystem",
      kind: "text",
      title: `${relativePath}${lineNumber ? `:${lineNumber}` : ""}`,
      content: lineText.slice(0, maxCharsPerItem),
      path: path.resolve(root, relativePath),
      score: rerank.score,
      metadata: {
        line: lineNumber ?? null,
        engine: "ripgrep",
        retrievalScore: rerank.score,
        rerankReasons: rerank.reasons
      }
    });
  }

  const ranked = evidence.sort(
    (left, right) => (right.score ?? 0) - (left.score ?? 0) || left.id.localeCompare(right.id)
  );
  const selected: ContextEvidence[] = [];
  const selectedIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const item of ranked) {
    const key = item.path ?? item.id;
    if (seenPaths.has(key)) continue;
    selected.push(item);
    selectedIds.add(item.id);
    seenPaths.add(key);
    if (selected.length >= maxItems) return selected;
  }

  for (const item of ranked) {
    if (selectedIds.has(item.id)) continue;
    selected.push(item);
    if (selected.length >= maxItems) break;
  }
  return selected;
}

async function enrichSourceSlices(
  evidence: readonly ContextEvidence[],
  limit: number,
  maxChars: number
): Promise<readonly ContextEvidence[]> {
  let enriched = 0;
  return Promise.all(evidence.map(async (item) => {
    if (enriched >= limit || !item.path || !isSourceCodePath(item.path)) return item;
    const line = Number(item.metadata?.line || 0);
    if (!Number.isFinite(line) || line <= 0) return item;
    enriched += 1;
    try {
      const text = await readFile(item.path, "utf8");
      const lines = text.split(/\r?\n/);
      const start = Math.max(1, line - 5);
      const end = Math.min(lines.length, line + 5);
      const slice = lines.slice(start - 1, end)
        .map((value, index) => `${start + index === line ? ">" : " "}${String(start + index).padStart(5)} | ${value}`)
        .join("\n")
        .slice(0, maxChars);
      if (!slice.trim()) return item;
      return {
        ...item,
        content: slice,
        metadata: {
          ...(item.metadata ?? {}),
          source_slice: true,
          slice_start: start,
          slice_end: end
        }
      };
    } catch {
      return item;
    }
  }));
}

function buildSearchProfile(request: TaskContextRequest): SearchProfile {
  const stopWords = new Set([
    "about", "after", "before", "could", "current", "debug", "explain", "find", "from", "have", "identify", "implementation", "including", "into", "likely", "make", "preserve", "report", "should", "that", "this", "what", "when", "where", "which", "with",
    "anh", "cai", "cho", "cua", "duoc", "giup", "khong", "lam", "nay", "nhung", "sao", "the", "tim", "trong", "va", "voi"
  ]);
  const byNormalized = new Map<string, SearchTerm>();
  const add = (value: string, kind: SearchTermKind): void => {
    const trimmed = value.trim().replace(/^[`'"([{]+|[`'"\])},;:!?]+$/g, "");
    const normalized = trimmed.toLowerCase().replace(/^[-./$]+|[-./$]+$/g, "");
    if (normalized.length < 3 || stopWords.has(normalized)) return;
    const existing = byNormalized.get(normalized);
    if (!existing || termPriority(kind) > termPriority(existing.kind)) {
      byNormalized.set(normalized, { value: trimmed, normalized, kind });
    }
  };

  const addExpanded = (value: string, kind: SearchTermKind): void => {
    add(value, kind);
    for (const part of splitSearchToken(value)) add(part, kind === "path" ? "keyword" : "keyword");
    if (kind === "path") {
      const base = path.basename(value).replace(/\.[a-z0-9]{1,8}$/i, "");
      if (base && base !== value) {
        add(base, looksLikeCodeSymbol(base) ? "symbol" : "keyword");
        for (const part of splitSearchToken(base)) add(part, "keyword");
      }
    }
  };

  for (const match of request.task.matchAll(/`([^`]{2,160})`/g)) {
    const value = match[1]?.trim();
    if (value) addExpanded(value, classifySearchTerm(value, true));
  }

  for (const token of request.task.match(/[\p{L}\p{N}_.$/-]+/gu) ?? []) {
    addExpanded(token, classifySearchTerm(token, false));
  }

  const ordered = [...byNormalized.values()].sort((left, right) =>
    termPriority(right.kind) - termPriority(left.kind)
  );
  const concrete = ordered.filter((term) => term.kind !== "keyword");
  const keywords = ordered.filter((term) => term.kind === "keyword");
  const terms = concrete.length > 0
    ? [...concrete.slice(0, 8), ...keywords.slice(0, 8)]
    : keywords.slice(0, 10);

  return {
    terms,
    hasConcreteTerms: concrete.length > 0,
    intent: request.intent ?? inferSearchIntent(request.task),
    taskLower: request.task.toLowerCase()
  };
}

function splitSearchToken(value: string): string[] {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_.\-/$\\]+/g, " ");
  return normalized.split(/\s+/).map((part) => part.trim()).filter((part) => part.length >= 3);
}

function inferSearchIntent(task: string): SearchProfile["intent"] {
  const text = task.toLowerCase();
  if (/\b(review|audit|check|risk)\b/.test(text)) return "review";
  if (/\b(debug|bug|error|fail|broken|why)\b/.test(text)) return "debug";
  if (/\b(refactor|cleanup|restructure)\b/.test(text)) return "refactor";
  if (/\b(implement|add|create|build|fix|change)\b/.test(text)) return "implement";
  if (/\b(understand|explain|trace|find|where|how)\b/.test(text)) return "understand";
  return "unknown";
}

function classifySearchTerm(value: string, explicitlyQuoted: boolean): SearchTermKind {
  const token = value.trim();
  if (looksLikePath(token)) return "path";
  if (explicitlyQuoted || looksLikeCodeSymbol(token)) return "symbol";
  return "keyword";
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes("\\") || /\.[a-z0-9]{1,8}$/i.test(value);
}

function looksLikeCodeSymbol(value: string): boolean {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) return false;
  return /[_$]/.test(value) || /[a-z0-9][A-Z]/.test(value) || /^[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/.test(value);
}

function termPriority(kind: SearchTermKind): number {
  if (kind === "path") return 3;
  if (kind === "symbol") return 2;
  return 1;
}

function scoreFilesystemMatch(
  relativePath: string,
  lineText: string,
  search: SearchProfile,
  changedFiles: readonly string[]
): { score: number; reasons: string[] } {
  const normalizedPath = relativePath.toLowerCase().replaceAll("\\", "/");
  const normalizedLine = lineText.toLowerCase();
  const base = path.posix.basename(normalizedPath);
  const reasons: string[] = [];
  let score = 30;
  let concreteMatches = 0;

  for (const term of search.terms) {
    const inPath = normalizedPath.includes(term.normalized);
    const inLine = normalizedLine.includes(term.normalized);
    if (!inPath && !inLine) continue;

    if (term.kind === "path") {
      score += inPath ? 42 : 14;
      concreteMatches += 1;
      reasons.push(inPath ? "path-match" : "path-token-line-match");
    } else if (term.kind === "symbol") {
      score += inLine ? 34 : 20;
      concreteMatches += 1;
      reasons.push(inLine ? "exact-symbol" : "symbol-in-path");
      if (inLine && looksLikeDefinition(lineText, term.value)) {
        const asksForReferences = /\b(callers?|references?|usages?|used by|where called)\b/.test(search.taskLower);
        score += asksForReferences ? 4 : 24;
        reasons.push(asksForReferences ? "definition-deemphasized" : "definition");
      } else if (inLine && /\b(callers?|references?|usages?|used by|where called)\b/.test(search.taskLower) && looksLikeCallUsage(lineText, term.value)) {
        score += 18;
        reasons.push("requested-usage");
      }
    } else {
      // Expanded fragments are recall helpers, not primary relevance signals.
      // Keep their contribution deliberately below an exact path/symbol match.
      score += inPath ? 5 : 3;
    }
    if (base.includes(term.normalized) && term.kind !== "keyword") {
      score += 16;
      reasons.push("basename-match");
    }
  }

  if (looksLikeComment(lineText)) {
    score -= 16;
    reasons.push("comment-penalty");
  }

  const exactChanged = changedFiles.some((file) => sameWorkspacePath(file, relativePath));
  if (exactChanged) {
    score += 28;
    reasons.push("changed-file");
  } else if (changedFiles.some((file) => nearbyWorkspacePath(file, relativePath))) {
    score += 12;
    reasons.push("changed-file-locality");
  }

  const source = isSourceCodePath(normalizedPath);
  const test = isTestPath(normalizedPath);
  const docs = isDocsPath(normalizedPath);
  if (source && !test) {
    score += search.intent === "implement" || search.intent === "refactor" ? 14 : 9;
    reasons.push("source-code");
  }
  if (test) {
    score += search.intent === "review" || search.intent === "debug" ? 14 : 2;
    reasons.push(search.intent === "review" || search.intent === "debug" ? "intent-test-boost" : "test-file");
  }
  if (docs) {
    score += search.intent === "understand" ? 4 : -14;
    reasons.push(search.intent === "understand" ? "understand-doc" : "docs-penalty");
  }
  if (isConfigPath(normalizedPath)) {
    if (/\b(config|manifest|script|dependency|package|build)\b/.test(search.taskLower)) {
      score += search.intent === "review" ? 12 : 7;
      reasons.push("explicit-config-match");
    } else {
      score -= 10;
      reasons.push("config-penalty");
    }
  }

  if (concreteMatches > 1) {
    score += Math.min(12, (concreteMatches - 1) * 4);
    reasons.push("multi-concrete-match");
  }
  if (search.hasConcreteTerms) score -= noisyPathPenalty(normalizedPath);

  return { score: Math.max(1, Math.min(200, score)), reasons: [...new Set(reasons)].slice(0, 8) };
}

function sameWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replaceAll("\\", "/").replace(/^\.\//, "");
  return normalize(left) === normalize(right);
}

function nearbyWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replaceAll("\\", "/").replace(/^\.\//, "");
  const leftDir = path.posix.dirname(normalize(left));
  const rightDir = path.posix.dirname(normalize(right));
  if (leftDir === "." || rightDir === ".") return false;
  if (leftDir === rightDir) return true;
  const leftParts = leftDir.split("/").filter(Boolean);
  const rightParts = rightDir.split("/").filter(Boolean);
  let common = 0;
  while (common < leftParts.length && common < rightParts.length && leftParts[common] === rightParts[common]) common += 1;
  return common >= 2 && (leftParts.length - common <= 1 || rightParts.length - common <= 1);
}

function looksLikeDefinition(lineText: string, symbol: string): boolean {
  const escaped = escapeRegExp(symbol);
  const patterns = [
    new RegExp(`\\b(?:class|interface|enum|type|function|def|record|struct)\\s+${escaped}\\b`, "i"),
    new RegExp(`\\b(?:const|let|var|final)\\s+${escaped}\\b`, "i"),
    new RegExp(`\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?(?:\\([^)]*\\)\\s*=>|function\\b)`, "i"),
    new RegExp(`^\\s*(?:(?:public|private|protected|internal|static|final|abstract|override|async|suspend|external)\\s+)*(?:void|dynamic|Future(?:<[^>]+>)?|[A-Z][A-Za-z0-9_$<>?,.\\[\\]]*)\\s+${escaped}\\s*\\(`),
    new RegExp(`^\\s*(?:async\\s+)?${escaped}\\s*\\([^)]*\\)\\s*(?:async\\s*)?(?:\\{|=>)`)
  ];
  return patterns.some((pattern) => pattern.test(lineText));
}

function looksLikeCallUsage(lineText: string, symbol: string): boolean {
  const escaped = escapeRegExp(symbol);
  return new RegExp(`\\b${escaped}\\s*\\(`).test(lineText) && !looksLikeDefinition(lineText, symbol);
}

function looksLikeComment(lineText: string): boolean {
  const trimmed = lineText.trim();
  return /^(?:\/\/|\/\*|\*|#|<!--)/.test(trimmed);
}

function isSourceCodePath(relativePath: string): boolean {
  return /\.(?:c|cc|cpp|cs|dart|go|java|js|jsx|kt|kts|mjs|mts|php|py|rb|rs|swift|ts|tsx|vue)$/i.test(relativePath);
}

function isTestPath(relativePath: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|$)/i.test(relativePath)
    || /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i.test(relativePath)
    || /_test\.(?:dart|py|go|rs)$/i.test(relativePath);
}

function isDocsPath(relativePath: string): boolean {
  const base = path.posix.basename(relativePath);
  return relativePath.startsWith("docs/")
    || relativePath.includes("/docs/")
    || /^(?:readme|changelog|contributing|architecture)(?:\.|$)/i.test(base)
    || /\.(?:md|mdx|rst)$/i.test(base);
}

function isConfigPath(relativePath: string): boolean {
  const base = path.posix.basename(relativePath);
  return /^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pubspec(?:\.lock|\.yaml)|analysis_options\.yaml|tsconfig.*\.json|jsconfig\.json|pyproject\.toml|go\.mod|cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|dockerfile|docker-compose.*\.ya?ml|\.eslintrc.*|eslint\.config\..*|\.prettierrc.*)$/i.test(base);
}

function noisyPathPenalty(relativePath: string): number {
  const base = path.posix.basename(relativePath);
  if (relativePath.includes("/.commandcode/") || relativePath.startsWith(".commandcode/")) return 55;
  if (/^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pubspec\.lock|cargo\.lock|poetry\.lock)$/i.test(base)) return 50;
  if ([".gitignore", "readme.md", "pubspec.yaml", "analysis_options.yaml", "license", "license.md"].includes(base)) return 38;
  if (relativePath.startsWith("docs/") || relativePath.includes("/docs/")) return 12;
  return 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function textValue(value: Record<string, unknown>): string | undefined {
  return typeof value.text === "string" ? value.text : undefined;
}
