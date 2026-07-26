import { BuildTaskContext } from "../application/context/build-task-context.js";
import type {
  CodeIntelligencePort,
  FilesystemContextPort,
  MemoryPort
} from "../ports/context-providers.js";

export interface ApplicationDependencies {
  filesystem: FilesystemContextPort;
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
