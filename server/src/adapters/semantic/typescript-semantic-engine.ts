import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { API, type NodeHandle, type Project, type Snapshot } from "typescript/unstable/sync";
import { isIdentifier, type Node, type SourceFile } from "typescript/unstable/ast";

import type { ContextEvidence, TaskContextRequest } from "../../domain/task-context.js";
import type { SemanticDiagnostic, SemanticDiagnosticsResult } from "../../ports/context-providers.js";
import type { SemanticEngine } from "./semantic-context-adapter.js";

const ENGINE_NAME = "typescript-7-native-api";
const FULL_REFRESH_TTL_MS = 5_000;
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const STOP_WORDS = new Set([
  "about", "after", "before", "build", "change", "check", "code", "context", "could", "current",
  "does", "file", "files", "find", "from", "function", "implement", "into", "issue", "make", "need",
  "project", "refactor", "remove", "service", "should", "that", "this", "trace", "understand", "what",
  "when", "where", "which", "with", "without", "would"
]);

interface SymbolLocation {
  path: string;
  line: number;
  column: number;
}

interface MatchedSymbol {
  name: string;
  term: string;
  declarations: SymbolLocation[];
  references: SymbolLocation[];
}

export class TypeScriptSemanticEngine implements SemanticEngine {
  readonly language = "typescript" as const;
  readonly name = ENGINE_NAME;
  private readonly sessions = new Map<string, TypeScriptProjectSession>();

  async context(request: TaskContextRequest): Promise<readonly ContextEvidence[]> {
    const root = path.resolve(request.root);
    const session = await this.sessionFor(root);
    const project = session.refresh(request.changedFiles ?? []);
    const terms = extractQueryTerms(request.task, request.changedFiles ?? []);
    if (terms.length === 0) return [];

    const maxItems = Math.max(1, Math.min(8, request.budget?.maxItems ?? 6));
    const maxChars = Math.max(1_000, Math.min(30_000, request.budget?.maxChars ?? 12_000));
    const sourceFiles = project.program.getSourceFileNames()
      .filter((file) => isProjectSource(root, file));
    const candidateFiles = await findCandidateFiles(
      root,
      sourceFiles,
      terms,
      request.changedFiles ?? [],
      Math.max(8, maxItems * 3)
    );

    const symbols = collectMatchedSymbols(project, root, candidateFiles, terms, maxItems);
    const perItemBudget = Math.max(700, Math.floor(maxChars / Math.max(1, symbols.length)));
    return symbols.map((symbol) => toEvidence(root, symbol, perItemBudget));
  }

  async diagnostics(root: string, changedFiles: readonly string[]): Promise<SemanticDiagnosticsResult> {
    const normalizedRoot = path.resolve(root);
    const session = await this.sessionFor(normalizedRoot);
    const project = session.refresh(changedFiles);
    const diagnostics: SemanticDiagnostic[] = [];
    const seen = new Set<string>();

    for (const file of changedFiles) {
      const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(normalizedRoot, file);
      const sourceFile = project.program.getSourceFile(absolute);
      if (!sourceFile) continue;
      const raw = [
        ...project.program.getSyntacticDiagnostics(absolute),
        ...project.program.getBindDiagnostics(absolute),
        ...project.program.getSemanticDiagnostics(absolute)
      ];
      for (const item of raw) {
        const position = sourceFile.getLineAndCharacterOfPosition(Math.max(0, item.pos ?? 0));
        const relative = path.relative(normalizedRoot, item.fileName || absolute);
        const diagnostic: SemanticDiagnostic = {
          path: relative && !relative.startsWith("..") ? relative : (item.fileName || absolute),
          line: position.line + 1,
          column: position.character + 1,
          severity: diagnosticSeverity(item.category),
          code: item.code,
          message: item.text
        };
        const key = `${diagnostic.path}:${diagnostic.line}:${diagnostic.column}:${diagnostic.code}:${diagnostic.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        diagnostics.push(diagnostic);
      }
    }

    return {
      diagnostics: diagnostics.slice(0, 100),
      language: "typescript",
      engine: ENGINE_NAME,
      available: true,
      state: "ready",
      fresh: true
    };
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    for (const session of this.sessions.values()) {
      try {
        session.close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.sessions.clear();
    if (errors.length > 0) throw new AggregateError(errors, "TypeScript semantic sessions failed to close.");
  }

  private async sessionFor(root: string): Promise<TypeScriptProjectSession> {
    const existing = this.sessions.get(root);
    if (existing) return existing;

    const configPath = await findTypeScriptConfig(root);
    if (!configPath) {
      throw new Error("No tsconfig.json or jsconfig.json was found at the project root.");
    }
    const session = new TypeScriptProjectSession(root, configPath);
    this.sessions.set(root, session);
    return session;
  }
}

class TypeScriptProjectSession {
  private readonly api: API;
  private snapshot: Snapshot | undefined;
  private lastFullRefreshAt = 0;

  constructor(
    private readonly root: string,
    private readonly configPath: string
  ) {
    this.api = new API({ cwd: root });
  }

  refresh(changedFiles: readonly string[] = []): Project {
    const now = Date.now();
    const next = !this.snapshot
      ? this.api.updateSnapshot({ openProjects: [this.configPath] })
      : changedFiles.length > 0
        ? this.api.updateSnapshot({ fileChanges: classifyFileChanges(this.root, this.snapshot, changedFiles) })
        : now - this.lastFullRefreshAt >= FULL_REFRESH_TTL_MS
          ? this.api.updateSnapshot({ fileChanges: { invalidateAll: true } })
          : this.api.updateSnapshot();
    this.snapshot?.dispose();
    this.snapshot = next;
    if (changedFiles.length === 0 || !this.lastFullRefreshAt) this.lastFullRefreshAt = now;

    const normalizedConfig = normalizePath(this.configPath);
    const project = next.getProjects().find((candidate) => normalizePath(candidate.configFileName) === normalizedConfig)
      ?? next.getProjects()[0];
    if (!project) throw new Error(`TypeScript did not load a project for ${this.root}.`);
    return project;
  }

  close(): void {
    this.snapshot?.dispose();
    this.snapshot = undefined;
    this.api.close();
  }
}

function classifyFileChanges(
  root: string,
  snapshot: Snapshot,
  changedFiles: readonly string[]
): { changed?: string[]; created?: string[]; deleted?: string[] } {
  const knownFiles = new Set(snapshot.getProjects()
    .flatMap((project) => project.program.getSourceFileNames())
    .map(normalizePath));
  const changed: string[] = [];
  const created: string[] = [];
  const deleted: string[] = [];

  for (const file of changedFiles) {
    const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
    const known = knownFiles.has(normalizePath(absolute));
    if (!existsSync(absolute)) deleted.push(absolute);
    else if (known) changed.push(absolute);
    else created.push(absolute);
  }

  return {
    ...(changed.length > 0 ? { changed } : {}),
    ...(created.length > 0 ? { created } : {}),
    ...(deleted.length > 0 ? { deleted } : {})
  };
}

async function findTypeScriptConfig(root: string): Promise<string | null> {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const candidate = path.join(root, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next config name.
    }
  }
  return null;
}

function extractQueryTerms(task: string, changedFiles: readonly string[]): string[] {
  const taskTerms = String(task).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  const fileTerms = changedFiles.flatMap((file) => {
    const base = path.basename(file).replace(/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, "");
    return base.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  });

  const seen = new Set<string>();
  return [...taskTerms, ...fileTerms]
    .filter((term) => term.length >= 3)
    .filter((term) => !STOP_WORDS.has(term.toLowerCase()))
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

async function findCandidateFiles(
  root: string,
  sourceFiles: readonly string[],
  terms: readonly string[],
  changedFiles: readonly string[],
  limit: number
): Promise<readonly string[]> {
  const sourceSet = new Set(sourceFiles.map(normalizePath));
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (file: string) => {
    const normalized = normalizePath(file);
    if (!sourceSet.has(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(file);
  };

  for (const file of changedFiles) {
    const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
    add(absolute);
  }

  const nameRanked = sourceFiles
    .filter((file) => !seen.has(normalizePath(file)))
    .sort((left, right) => fileNameScore(right, terms) - fileNameScore(left, terms));

  const batchSize = 32;
  const maxScannedFiles = Math.min(800, nameRanked.length);
  for (let offset = 0; offset < maxScannedFiles && candidates.length < limit; offset += batchSize) {
    const batch = nameRanked.slice(offset, Math.min(maxScannedFiles, offset + batchSize));
    const texts = await Promise.all(batch.map((file) => readFile(file, "utf8").catch(() => "")));
    for (let index = 0; index < batch.length && candidates.length < limit; index += 1) {
      const file = batch[index];
      const text = texts[index] ?? "";
      if (file && containsAnyIdentifier(text, terms)) add(file);
    }
  }

  return candidates;
}

function fileNameScore(file: string, terms: readonly string[]): number {
  const base = path.basename(file).toLowerCase();
  return terms.reduce((score, term) => score + (base.includes(term.toLowerCase()) ? 1 : 0), 0);
}

function containsAnyIdentifier(text: string, terms: readonly string[]): boolean {
  for (const term of terms) {
    const expression = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(term)}([^A-Za-z0-9_$]|$)`, "i");
    if (expression.test(text)) return true;
  }
  return false;
}

function collectMatchedSymbols(
  project: Project,
  root: string,
  candidateFiles: readonly string[],
  terms: readonly string[],
  limit: number
): readonly MatchedSymbol[] {
  const termByLower = new Map(terms.map((term) => [term.toLowerCase(), term]));
  const seenSymbols = new Set<string>();
  const matches: MatchedSymbol[] = [];

  for (const fileName of candidateFiles) {
    if (matches.length >= limit) break;
    const sourceFile = project.program.getSourceFile(fileName);
    if (!sourceFile) continue;

    walk(sourceFile, (node) => {
      if (matches.length >= limit || !isIdentifier(node)) return;
      const term = termByLower.get(node.text.toLowerCase());
      if (!term) return;

      const symbol = project.checker.getSymbolAtLocation(node);
      if (!symbol) return;
      const key = `${symbol.name}\u0000${symbol.declarations.map((entry) => String(entry.path)).sort().join("|")}`;
      if (seenSymbols.has(key)) return;
      seenSymbols.add(key);

      const declarations = uniqueLocations(symbol.declarations
        .map((handle) => locationForHandle(root, handle))
        .filter((location): location is SymbolLocation => location !== null));
      const referenced = project.checker.getReferencedSymbolsForNode(node, node.getStart(sourceFile));
      const references = uniqueLocations(referenced
        .flatMap((entry) => entry.references)
        .map((handle) => locationForHandle(root, handle))
        .filter((location): location is SymbolLocation => location !== null));

      matches.push({
        name: symbol.name || node.text,
        term,
        declarations: declarations.slice(0, 6),
        references: references.slice(0, 16)
      });
    });
  }

  return matches;
}

function walk(node: Node, visitor: (node: Node) => void): void {
  visitor(node);
  node.forEachChild((child) => {
    walk(child, visitor);
    return undefined;
  });
}

function locationForHandle(root: string, handle: NodeHandle): SymbolLocation | null {
  const node = handle.resolve();
  if (!node) return null;
  const sourceFile = node.getSourceFile();
  if (!isProjectSource(root, sourceFile.fileName)) return null;
  return locationForNode(root, sourceFile, node);
}

function locationForNode(root: string, sourceFile: SourceFile, node: Node): SymbolLocation {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const relative = path.relative(root, sourceFile.fileName);
  return {
    path: relative && !relative.startsWith("..") ? relative : sourceFile.fileName,
    line: position.line + 1,
    column: position.character + 1
  };
}

function uniqueLocations(locations: readonly SymbolLocation[]): SymbolLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.path}:${location.line}:${location.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toEvidence(root: string, symbol: MatchedSymbol, maxChars: number): ContextEvidence {
  const declarationLines = symbol.declarations.length > 0
    ? symbol.declarations.map((location) => `- ${formatLocation(location)}`)
    : ["- no in-project declaration resolved"];
  const referenceLines = symbol.references.length > 0
    ? symbol.references.map((location) => `- ${formatLocation(location)}`)
    : ["- no in-project references resolved"];
  const content = [
    `${symbol.name} (query term: ${symbol.term})`,
    `Definitions (${symbol.declarations.length}):`,
    ...declarationLines,
    `References (${symbol.references.length}):`,
    ...referenceLines
  ].join("\n");
  const bounded = content.slice(0, maxChars);

  return {
    id: `semantic-ts-${shortHash(`${root}\u0000${symbol.name}\u0000${content}`)}`,
    provider: "semantic",
    kind: "relationship",
    title: `TypeScript semantic symbol: ${symbol.name}`,
    content: bounded,
    symbol: symbol.name,
    ...(symbol.declarations[0]?.path ? { path: symbol.declarations[0].path } : {}),
    score: symbol.name.toLowerCase() === symbol.term.toLowerCase() ? 96 : 92,
    metadata: {
      language: "typescript",
      engine: ENGINE_NAME,
      definition_count: symbol.declarations.length,
      reference_count: symbol.references.length,
      truncated: bounded.length < content.length
    }
  };
}

function formatLocation(location: SymbolLocation): string {
  return `${location.path}:${location.line}:${location.column}`;
}

function isProjectSource(root: string, file: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedFile = normalizePath(file);
  if (!(normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`))) return false;
  if (!SOURCE_EXTENSIONS.test(file) || /\.d\.(?:ts|mts|cts)$/i.test(file)) return false;
  return !normalizedFile.includes("/node_modules/")
    && !normalizedFile.includes("/.git/")
    && !normalizedFile.includes("/dist/")
    && !normalizedFile.includes("/build/");
}

function normalizePath(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function diagnosticSeverity(category: number): SemanticDiagnostic["severity"] {
  if (category === 1) return "error";
  if (category === 0) return "warning";
  if (category === 2) return "suggestion";
  return "message";
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
