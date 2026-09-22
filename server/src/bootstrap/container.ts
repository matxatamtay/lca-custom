import { BuildTaskContext } from "../application/context/build-task-context.js";
import type {
  CodeIntelligencePort,
  ContextRerankerPort,
  FilesystemContextPort,
  MemoryPort,
  SemanticContextPort
} from "../ports/context-providers.js";

export interface ApplicationDependencies {
  filesystem: FilesystemContextPort;
  semantic: SemanticContextPort;
  codegraph: CodeIntelligencePort;
  agentmemory: MemoryPort;
  reranker?: ContextRerankerPort;
  traceSpan?: <T>(name: string, operation: () => Promise<T> | T) => Promise<T>;
}

export interface ApplicationContainer {
  buildTaskContext: BuildTaskContext;
  semantic: SemanticContextPort;
}

export function createApplicationContainer(dependencies: ApplicationDependencies): ApplicationContainer {
  return {
    buildTaskContext: new BuildTaskContext(dependencies),
    semantic: dependencies.semantic
  };
}
