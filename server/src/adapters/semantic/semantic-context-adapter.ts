import { access } from "node:fs/promises";
import path from "node:path";

import type { ContextEvidence, TaskContextRequest } from "../../domain/task-context.js";
import type {
  SemanticContextPort,
  SemanticContextResult,
  SemanticContextState,
  SemanticLanguage
} from "../../ports/context-providers.js";
import { DartSemanticEngine } from "./dart-semantic-engine.js";
import { JavaSemanticEngine } from "./java-semantic-engine.js";
import { TypeScriptSemanticEngine } from "./typescript-semantic-engine.js";

export interface SemanticEngineResult {
  evidence: readonly ContextEvidence[];
  state?: SemanticContextState;
  reason?: string;
}

export interface SemanticEngine {
  readonly language: Exclude<SemanticLanguage, "unknown">;
  readonly name: string;
  context(request: TaskContextRequest): Promise<readonly ContextEvidence[] | SemanticEngineResult>;
  close?(): Promise<void>;
}

export class SemanticContextAdapter implements SemanticContextPort {
  private readonly engines: ReadonlyMap<Exclude<SemanticLanguage, "unknown">, SemanticEngine>;

  constructor(engines: readonly SemanticEngine[]) {
    this.engines = new Map(engines.map((engine) => [engine.language, engine]));
  }

  async context(request: TaskContextRequest): Promise<SemanticContextResult> {
    const language = await detectSemanticLanguage(request.root, request.changedFiles ?? []);
    if (language === "unknown") {
      return {
        evidence: [],
        language,
        engine: null,
        available: false,
        state: "unavailable",
        reason: "No TypeScript/JavaScript, Dart/Flutter, or Java project markers were detected."
      };
    }

    const engine = this.engines.get(language);
    if (!engine) {
      return {
        evidence: [],
        language,
        engine: null,
        available: false,
        state: "unavailable",
        reason: `${language} semantic engine is not registered yet.`
      };
    }

    try {
      const raw = await engine.context(request);
      const normalized: SemanticEngineResult = isEvidenceArray(raw)
        ? { evidence: raw, state: "ready" as const }
        : raw;
      const state = normalized.state ?? "ready";
      return {
        evidence: normalized.evidence,
        language,
        engine: engine.name,
        available: state === "ready",
        state,
        ...(normalized.reason ? { reason: normalized.reason } : {})
      };
    } catch (error) {
      return {
        evidence: [],
        language,
        engine: engine.name,
        available: false,
        state: "unavailable",
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async close(): Promise<void> {
    const closers = [...this.engines.values()]
      .filter((engine) => typeof engine.close === "function")
      .map((engine) => engine.close!());
    const settled = await Promise.allSettled(closers);
    const errors = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) throw new AggregateError(errors, "Semantic engines failed to close.");
  }
}

export function createDefaultSemanticContextAdapter(): SemanticContextAdapter {
  return new SemanticContextAdapter([
    new TypeScriptSemanticEngine(),
    new DartSemanticEngine(),
    new JavaSemanticEngine()
  ]);
}

export async function detectSemanticLanguage(
  root: string,
  changedFiles: readonly string[] = []
): Promise<SemanticLanguage> {
  for (const file of changedFiles) {
    const language = languageForExtension(file);
    if (language !== "unknown") return language;
  }

  const normalizedRoot = path.resolve(root);
  const [dart, java, ts] = await Promise.all([
    anyExists(normalizedRoot, ["pubspec.yaml"]),
    anyExists(normalizedRoot, ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]),
    anyExists(normalizedRoot, ["tsconfig.json", "jsconfig.json", "package.json"])
  ]);

  if (dart) return "dart";
  if (java) return "java";
  if (ts) return "typescript";
  return "unknown";
}

function languageForExtension(file: string): SemanticLanguage {
  const normalized = file.toLowerCase();
  if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(normalized)) return "typescript";
  if (normalized.endsWith(".dart")) return "dart";
  if (normalized.endsWith(".java")) return "java";
  return "unknown";
}

async function anyExists(root: string, names: readonly string[]): Promise<boolean> {
  const results = await Promise.all(names.map(async (name) => {
    try {
      await access(path.join(root, name));
      return true;
    } catch {
      return false;
    }
  }));
  return results.some(Boolean);
}

function isEvidenceArray(value: readonly ContextEvidence[] | SemanticEngineResult): value is readonly ContextEvidence[] {
  return Array.isArray(value);
}
