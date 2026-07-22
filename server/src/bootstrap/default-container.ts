import { AgentMemoryHttpAdapter } from "../adapters/agentmemory/agentmemory-http-adapter.js";
import { createDefaultCodeGraphAdapter, type CodeGraphAdapter } from "../adapters/codegraph/codegraph-adapter.js";
import { RipgrepFilesystemContextAdapter } from "../adapters/filesystem/ripgrep-filesystem-context-adapter.js";
import {
  AgentMemoryCliController,
  AgentMemorySupervisor,
  HttpAgentMemoryHealthProbe
} from "../orchestration/agentmemory-supervisor.js";
import {
  AgentMemorySessionManager,
  SessionAwareMemoryPort
} from "../orchestration/agentmemory-session-manager.js";
import { createApplicationContainer, type ApplicationContainer } from "./container.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface DefaultContainerOptions {
  agentMemoryUrl?: string;
  agentMemorySecret?: string;
  agentMemoryRuntimeDirectory?: string;
  autoStartAgentMemory?: boolean;
}

export interface ManagedApplicationContainer {
  application: ApplicationContainer;
  memorySessions: AgentMemorySessionManager;
  close(): Promise<void>;
}

export function createDefaultApplicationContainer(
  options: DefaultContainerOptions = {}
): ManagedApplicationContainer {
  const codegraph: CodeGraphAdapter = createDefaultCodeGraphAdapter();
  const agentMemoryUrl = options.agentMemoryUrl ?? "http://127.0.0.1:3111";
  let memorySessions: AgentMemorySessionManager | undefined;
  const agentmemory = new AgentMemoryHttpAdapter({
    baseUrl: agentMemoryUrl,
    ...(options.agentMemorySecret ? { secret: options.agentMemorySecret } : {}),
    sessionIdForRoot: (root) => memorySessions?.currentSessionId(root)
  });
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const runtimeDirectory = options.agentMemoryRuntimeDirectory
    ?? path.join(repoRoot, "runtime", "agentmemory");
  const supervisor = new AgentMemorySupervisor({
    probe: new HttpAgentMemoryHealthProbe({ baseUrl: agentMemoryUrl }),
    runtime: new AgentMemoryCliController({ runtimeDirectory })
  });
  memorySessions = new AgentMemorySessionManager({
    supervisor,
    client: agentmemory
  });
  const memoryPort = options.autoStartAgentMemory === false
    ? agentmemory
    : new SessionAwareMemoryPort(memorySessions, agentmemory);

  return {
    application: createApplicationContainer({
      filesystem: new RipgrepFilesystemContextAdapter(),
      codegraph,
      agentmemory: memoryPort
    }),
    memorySessions,
    async close() {
      const errors: unknown[] = [];
      try { await memorySessions.close(); } catch (error) { errors.push(error); }
      try { await codegraph.close(); } catch (error) { errors.push(error); }
      try { await supervisor.close(); } catch (error) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, "Managed application close failed.");
    }
  };
}
