import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspLocation { uri: string; range: LspRange }
export interface LspSymbol { name: string; kind?: number; location: LspLocation }
export interface CompactLocation { path: string; line: number; column: number }

const STOP_WORDS = new Set([
  "about", "after", "before", "build", "change", "check", "code", "context", "could", "current",
  "caller", "callers", "definition", "definitions", "does", "file", "files", "find", "from", "function", "implement", "into", "issue", "make", "need",
  "project", "refactor", "reference", "references", "remove", "service", "should", "that", "this", "trace", "understand", "what",
  "when", "where", "which", "with", "without", "would"
]);

export async function serverRequestHandler(method: string, params: unknown): Promise<unknown> {
  if (method === "workspace/configuration") {
    const items = asRecord(params).items;
    return Array.isArray(items) ? items.map(() => null) : [];
  }
  if (method === "window/workDoneProgress/create" || method === "client/registerCapability" || method === "client/unregisterCapability") {
    return null;
  }
  return null;
}

export function extractQueryTerms(task: string, changedFiles: readonly string[], language: "dart" | "java"): string[] {
  const extension = language === "dart" ? /\.dart$/i : /\.java$/i;
  const taskTerms = String(task).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  const fileTerms = changedFiles.flatMap((file) => path.basename(file).replace(extension, "").match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
  const seen = new Set<string>();
  return [...taskTerms, ...fileTerms]
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term.toLowerCase()))
    .sort((left, right) => termPriority(right) - termPriority(left) || right.length - left.length)
    .filter((term) => {
      const key = term.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function termPriority(term: string): number {
  let score = 0;
  if (/[A-Z]/.test(term.slice(1))) score += 4;
  if (/[_$]/.test(term)) score += 2;
  if (term.length >= 8) score += 1;
  return score;
}

function parseSymbol(value: unknown): LspSymbol | null {
  const record = asRecord(value);
  const name = typeof record.name === "string" ? record.name : "";
  const location = parseLocation(record.location);
  if (!name || !location) return null;
  return {
    name,
    ...(typeof record.kind === "number" ? { kind: record.kind } : {}),
    location
  };
}

export function parseSymbols(value: unknown): readonly LspSymbol[] {
  return Array.isArray(value)
    ? value.map(parseSymbol).filter((item): item is LspSymbol => item !== null)
    : [];
}

function parseLocation(value: unknown): LspLocation | null {
  const record = asRecord(value);
  const uri = typeof record.uri === "string" ? record.uri : "";
  const range = parseRange(record.range);
  return uri && range ? { uri, range } : null;
}

function parseRange(value: unknown): LspRange | null {
  const record = asRecord(value);
  const start = parsePosition(record.start);
  const end = parsePosition(record.end);
  return start && end ? { start, end } : null;
}

function parsePosition(value: unknown): LspPosition | null {
  const record = asRecord(value);
  return typeof record.line === "number" && typeof record.character === "number"
    ? { line: record.line, character: record.character }
    : null;
}

export function locationsFromResult(value: unknown): LspLocation[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const result: LspLocation[] = [];
  for (const item of values) {
    const record = asRecord(item);
    const direct = parseLocation(record);
    if (direct) {
      result.push(direct);
      continue;
    }
    const targetUri = typeof record.targetUri === "string" ? record.targetUri : "";
    const targetRange = parseRange(record.targetSelectionRange ?? record.targetRange);
    if (targetUri && targetRange) result.push({ uri: targetUri, range: targetRange });
  }
  return result;
}

export async function symbolPosition(symbol: LspSymbol): Promise<LspPosition> {
  const start = symbol.location.range.start;
  if (!symbol.location.uri.startsWith("file:")) return start;
  try {
    const file = fileURLToPath(symbol.location.uri);
    const text = await readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    const lastLine = Math.min(symbol.location.range.end.line, start.line + 12, lines.length - 1);
    const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(symbol.name)}([^A-Za-z0-9_$]|$)`);
    for (let line = Math.max(0, start.line); line <= lastLine; line += 1) {
      const value = lines[line] ?? "";
      const match = pattern.exec(value);
      if (match) return { line, character: match.index + (match[1]?.length ?? 0) };
    }
  } catch {
    // Fall back to the symbol range start.
  }
  return start;
}

export function compactLocation(root: string, location: LspLocation): CompactLocation | null {
  if (!location.uri.startsWith("file:")) return null;
  try {
    const file = fileURLToPath(location.uri);
    if (!isPathWithin(root, file)) return null;
    const relative = path.relative(root, file);
    return {
      path: relative && !relative.startsWith("..") ? relative : file,
      line: location.range.start.line + 1,
      column: location.range.start.character + 1
    };
  } catch {
    return null;
  }
}

export function uniqueLocations(locations: readonly CompactLocation[]): CompactLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.path}:${location.line}:${location.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isWithinRoot(root: string, uri: string): boolean {
  if (!uri.startsWith("file:")) return false;
  try { return isPathWithin(root, fileURLToPath(uri)); } catch { return false; }
}

function isPathWithin(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function symbolRank(name: string, term: string): number {
  const left = name.toLowerCase();
  const right = term.toLowerCase();
  if (left === right) return 4;
  if (left.startsWith(right)) return 3;
  if (left.includes(right)) return 2;
  return 1;
}

export function selectRelevantSymbols(symbols: readonly LspSymbol[], term: string): LspSymbol[] {
  const ranked = [...symbols].sort((left, right) => symbolRank(right.name, term) - symbolRank(left.name, term));
  const exact = ranked.filter((symbol) => symbol.name.toLowerCase() === term.toLowerCase());
  if (exact.length > 0) return exact;
  return ranked.filter((symbol) => symbolRank(symbol.name, term) >= 2);
}

export function displayLanguage(language: "dart" | "java"): string {
  return language === "dart" ? "Dart" : "Java";
}

export function formatLocation(location: CompactLocation): string {
  return `${location.path}:${location.line}:${location.column}`;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
