import { BuildTaskContext } from "../application/context/build-task-context.js";
import type {
  CodeIntelligencePort,
  FilesystemContextPort,
  MemoryPort,
  SemanticContextPort
} from "../ports/context-providers.js";

export interface ApplicationDependencies {
  filesystem: FilesystemContextPort;
  semantic: SemanticContextPort;
  codegraph: CodeIntelligencePort;
  agentmemory: MemoryPort;
}

export interface ApplicationContainer {
  buildTaskContext: BuildTaskContext;
}

export function createApplicationContainer(dependencies: ApplicationDependencies): ApplicationContainer {
  return {
    buildTaskContext: new BuildTaskContext(dependencies)
  };
}
