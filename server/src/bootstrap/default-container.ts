import { AgentMemoryHttpAdapter } from "../adapters/agentmemory/agentmemory-http-adapter.js";
import { createDefaultCodeGraphAdapter, type CodeGraphAdapter } from "../adapters/codegraph/codegraph-adapter.js";
import { RipgrepFilesystemContextAdapter } from "../adapters/filesystem/ripgrep-filesystem-context-adapter.js";
import {
  createOptionalJevContextReranker,
  type OptionalJevContextRerankerOptions
} from "../adapters/jev/jev-context-reranker.js";
import {
  createDefaultSemanticContextAdapter,
  type SemanticContextAdapter
} from "../adapters/semantic/semantic-context-adapter.js";
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
import {
  RevisionAwareFilesystemContextPort,
  RevisionAwareSemanticContextPort,
  WorkspaceRevisionTracker
} from "../application/context/context-hot-runtime.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export interface DefaultContainerOptions {
  agentMemoryUrl?: string;
  agentMemorySecret?: string;
  agentMemoryRuntimeDirectory?: string;
  autoStartAgentMemory?: boolean;
  jevEnabled?: boolean;
  jevApiToken?: string;
  jevEndpoint?: string;
  jevModel?: string;
  jevTimeoutMs?: number;
  jevMaxCandidates?: number;
  jevMaxStateChars?: number;
  traceSpan?: <T>(name: string, operation: () => Promise<T> | T) => Promise<T>;
}

export interface PrewarmProviderReceipt {
  status: "fulfilled" | "rejected";
  latencyMs: number;
}

export interface ContextPrewarmReceipt {
  codegraph: PrewarmProviderReceipt;
  agentmemory: PrewarmProviderReceipt;
  semantic: PrewarmProviderReceipt;
}

export interface ManagedApplicationContainer {
  application: ApplicationContainer;
  memorySessions: AgentMemorySessionManager;
  invalidateContext(root: string, changedFiles?: readonly string[]): void;
  prewarmContext(root: string, changedFiles?: readonly string[]): Promise<ContextPrewarmReceipt>;
  close(): Promise<void>;
}

async function settlePrewarm(operation: () => Promise<unknown>): Promise<PrewarmProviderReceipt> {
  const startedAt = performance.now();
  try {
    await operation();
    return {
      status: "fulfilled",
      latencyMs: Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10)
    };
  } catch {
    return {
      status: "rejected",
      latencyMs: Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10)
    };
  }
}

export function createDefaultApplicationContainer(
  options: DefaultContainerOptions = {}
): ManagedApplicationContainer {
  const codegraph: CodeGraphAdapter = createDefaultCodeGraphAdapter();
  const revisions = new WorkspaceRevisionTracker();
  const filesystem = new RevisionAwareFilesystemContextPort(new RipgrepFilesystemContextAdapter(), revisions);
  const semanticBase: SemanticContextAdapter = createDefaultSemanticContextAdapter();
  const semantic = new RevisionAwareSemanticContextPort(semanticBase, revisions);
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
  const patchModuleUrl = pathToFileURL(
    path.join(repoRoot, "scripts", "agentmemory-runtime-patches.mjs")
  ).href;
  const supervisor = new AgentMemorySupervisor({
    probe: new HttpAgentMemoryHealthProbe({
      baseUrl: agentMemoryUrl,
      ...(options.agentMemorySecret ? { secret: options.agentMemorySecret } : {})
    }),
    runtime: new AgentMemoryCliController({
      runtimeDirectory,
      prepareRuntime: async (directory) => {
        const patches = await import(patchModuleUrl) as {
          applyAgentMemoryRuntimePatches(runtimeDirectory: string): unknown;
        };
        patches.applyAgentMemoryRuntimePatches(directory);
      }
    })
  });
  memorySessions = new AgentMemorySessionManager({
    supervisor,
    client: agentmemory
  });
  const memoryPort = options.autoStartAgentMemory === false
    ? agentmemory
    : new SessionAwareMemoryPort(memorySessions, agentmemory);
  const jevOptions: OptionalJevContextRerankerOptions = {
    enabled: options.jevEnabled ?? true,
    ...(options.jevApiToken !== undefined ? { apiToken: options.jevApiToken } : {}),
    ...(options.jevEndpoint !== undefined ? { endpoint: options.jevEndpoint } : {}),
    ...(options.jevModel !== undefined ? { model: options.jevModel } : {}),
    ...(options.jevTimeoutMs !== undefined ? { timeoutMs: options.jevTimeoutMs } : {}),
    ...(options.jevMaxCandidates !== undefined ? { maxCandidates: options.jevMaxCandidates } : {}),
    ...(options.jevMaxStateChars !== undefined ? { maxStateChars: options.jevMaxStateChars } : {})
  };
  const reranker = createOptionalJevContextReranker(jevOptions);

  return {
    application: createApplicationContainer({
      filesystem,
      semantic,
      codegraph,
      agentmemory: memoryPort,
      ...(reranker ? { reranker } : {}),
      ...(options.traceSpan ? { traceSpan: options.traceSpan } : {})
    }),
    memorySessions,
    invalidateContext(root, changedFiles = []) {
      revisions.bump(root);
      filesystem.invalidate(root);
      semantic.invalidate(root);
      void Promise.allSettled([
        codegraph.ensureIndexed(root, changedFiles),
        semantic.context({
          task: "Warm semantic project state after local edits",
          root,
          ...(changedFiles.length ? { changedFiles } : {}),
          budget: { maxItems: 3, maxChars: 2000 }
        })
      ]);
    },
    async prewarmContext(root, changedFiles = []) {
      const [codegraphReceipt, memoryReceipt, semanticReceipt] = await Promise.all([
        settlePrewarm(() => changedFiles.length
          ? codegraph.ensureIndexed(root, changedFiles)
          : (codegraph.prewarm?.(root) ?? codegraph.ensureIndexed(root))),
        settlePrewarm(() => memorySessions.ensureSession(root, "Prewarm project context")),
        settlePrewarm(() => semantic.context({
          task: "Warm project semantic state",
          root,
          ...(changedFiles.length ? { changedFiles } : {}),
          budget: { maxItems: 3, maxChars: 2000 }
        }))
      ]);
      return {
        codegraph: codegraphReceipt,
        agentmemory: memoryReceipt,
        semantic: semanticReceipt
      };
    },
    async close() {
      const errors: unknown[] = [];
      try { revisions.close(); } catch (error) { errors.push(error); }
      try { await memorySessions.close(); } catch (error) { errors.push(error); }
      try { await semantic.close(); } catch (error) { errors.push(error); }
      try { await codegraph.close(); } catch (error) { errors.push(error); }
      try { await supervisor.close(); } catch (error) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, "Managed application close failed.");
    }
  };
}
