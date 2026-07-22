import type { ContextEvidence, TaskContextRequest } from "../domain/task-context.js";

export interface FilesystemContextPort {
  search(request: TaskContextRequest): Promise<readonly ContextEvidence[]>;
}

export interface CodeIntelligencePort {
  ensureIndexed(root: string): Promise<void>;
  context(request: TaskContextRequest): Promise<readonly ContextEvidence[]>;
}

export interface MemoryPort {
  recall(request: TaskContextRequest): Promise<readonly ContextEvidence[]>;
}
