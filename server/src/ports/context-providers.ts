import type {
  ContextEvidence,
  ContextRanking,
  TaskContextRequest
} from "../domain/task-context.js";

export interface FilesystemContextPort {
  search(request: TaskContextRequest): Promise<readonly ContextEvidence[]>;
}

export interface CodeIntelligencePort {
  ensureIndexed(root: string, changedFiles?: readonly string[]): Promise<void>;
  context(request: TaskContextRequest): Promise<readonly ContextEvidence[]>;
  prewarm?(root: string): Promise<void>;
  telemetry?(root: string): Readonly<Record<string, unknown>> | undefined;
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

export type SemanticDiagnosticSeverity = "error" | "warning" | "suggestion" | "message";

export interface SemanticDiagnostic {
  path?: string;
  line?: number;
  column?: number;
  severity: SemanticDiagnosticSeverity;
  code?: string | number;
  message: string;
}

export interface SemanticDiagnosticsResult {
  diagnostics: readonly SemanticDiagnostic[];
  language: SemanticLanguage;
  engine: string | null;
  available: boolean;
  state?: SemanticContextState;
  fresh?: boolean;
  reason?: string;
}

export interface SemanticContextPort {
  context(request: TaskContextRequest): Promise<SemanticContextResult>;
  diagnostics?(root: string, changedFiles: readonly string[]): Promise<SemanticDiagnosticsResult>;
  close?(): Promise<void>;
}

export interface MemoryPort {
  recall(request: TaskContextRequest): Promise<readonly ContextEvidence[]>;
}

export interface ContextRerankResult {
  evidence: readonly ContextEvidence[];
  ranking: ContextRanking;
}

export interface ContextRerankerPort {
  rerank(
    request: TaskContextRequest,
    evidence: readonly ContextEvidence[]
  ): Promise<ContextRerankResult>;
}
