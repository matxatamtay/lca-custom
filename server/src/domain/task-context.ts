export const CONTEXT_PROVIDER_NAMES = ["filesystem", "codegraph", "agentmemory"] as const;

export type ContextProviderName = (typeof CONTEXT_PROVIDER_NAMES)[number];

export type TaskIntent = "understand" | "debug" | "implement" | "refactor" | "review";

export interface TaskContextBudget {
  maxItems?: number;
  maxChars?: number;
}

export interface TaskContextRequest {
  task: string;
  root: string;
  intent?: TaskIntent;
  changedFiles?: readonly string[];
  budget?: TaskContextBudget;
}

export interface ContextEvidence {
  id: string;
  provider: ContextProviderName;
  kind: "file" | "symbol" | "relationship" | "memory" | "text";
  title: string;
  content: string;
  path?: string;
  symbol?: string;
  score?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ProviderCoverage {
  queried: true;
  status: "ok";
  hits: number;
  latencyMs: number;
}

export type ContextCoverage = Readonly<Record<ContextProviderName, ProviderCoverage>>;

export interface TaskContext {
  contextId: string;
  task: string;
  root: string;
  generatedAt: string;
  coverage: ContextCoverage;
  evidence: readonly ContextEvidence[];
}

export class ContextProviderUnavailableError extends Error {
  readonly provider: ContextProviderName;
  readonly originalError: unknown;

  constructor(provider: ContextProviderName, originalError: unknown) {
    const detail = originalError instanceof Error ? originalError.message : String(originalError);
    super(`Required context provider ${provider} failed: ${detail}`);
    this.name = "ContextProviderUnavailableError";
    this.provider = provider;
    this.originalError = originalError;
  }
}
