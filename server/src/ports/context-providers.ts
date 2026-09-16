import type { ContextEvidence, TaskContextRequest } from "../domain/task-context.js";

export interface FilesystemContextPort {
  search(request: TaskContextRequest): Promise<readonly ContextEvidence[]>;
}

export interface CodeIntelligencePort {
  ensureIndexed(root: string, changedFiles?: readonly string[]): Promise<void>;
  context(request: TaskContextRequest): Promise<readonly ContextEvidence[]>;
}

export type SemanticLanguage = "typescript" | "dart" | "java" | "unknown";
export type SemanticContextState = "ready" | "warming" | "unavailable";

export interface SemanticContextResult {
  evidence: readonly ContextEvidence[];
  language: SemanticLanguage;
  engine: string | null;
  available: boolean;
  state?: SemanticContextState;
  reason?: string;
}

export interface SemanticContextPort {
  context(request: TaskContextRequest): Promise<SemanticContextResult>;
  close?(): Promise<void>;
}

export interface MemoryPort {
  recall(request: TaskContextRequest): Promise<readonly ContextEvidence[]>;
}
