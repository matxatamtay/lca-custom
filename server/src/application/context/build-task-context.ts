import { randomUUID } from "node:crypto";

import {
  ContextProviderUnavailableError,
  type ContextCoverage,
  type ContextEvidence,
  type ContextProviderName,
  type ProviderCoverage,
  type TaskContext,
  type TaskContextRequest
} from "../../domain/task-context.js";
import type {
  CodeIntelligencePort,
  FilesystemContextPort,
  MemoryPort
} from "../../ports/context-providers.js";

interface ProviderResult {
  provider: ContextProviderName;
  evidence: readonly ContextEvidence[];
  latencyMs: number;
}

export interface BuildTaskContextDependencies {
  filesystem: FilesystemContextPort;
  codegraph: CodeIntelligencePort;
  agentmemory: MemoryPort;
  now?: () => Date;
  createId?: () => string;
}

const PROVIDER_PRIORITY: Readonly<Record<ContextProviderName, number>> = {
  filesystem: 3,
  codegraph: 2,
  agentmemory: 1
};

export class BuildTaskContext {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly dependencies: BuildTaskContextDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? randomUUID;
  }

  async execute(request: TaskContextRequest): Promise<TaskContext> {
    const task = request.task.trim();
    if (!task) throw new Error("Task context requires a non-empty task.");

    const normalizedRequest: TaskContextRequest = { ...request, task };

    const [filesystem, codegraph, agentmemory] = await Promise.all([
      this.runProvider("filesystem", () => this.dependencies.filesystem.search(normalizedRequest)),
      this.runProvider("codegraph", async () => {
        await this.dependencies.codegraph.ensureIndexed(normalizedRequest.root);
        return this.dependencies.codegraph.context(normalizedRequest);
      }),
      this.runProvider("agentmemory", () => this.dependencies.agentmemory.recall(normalizedRequest))
    ]);

    const providerResults = [filesystem, codegraph, agentmemory] as const;
    const coverage = Object.fromEntries(
      providerResults.map((result) => [result.provider, this.toCoverage(result)])
    ) as ContextCoverage;

    return {
      contextId: this.createId(),
      task,
      root: normalizedRequest.root,
      generatedAt: this.now().toISOString(),
      coverage,
      evidence: mergeEvidence(providerResults, normalizedRequest.budget?.maxItems ?? 50)
    };
  }

  private async runProvider(
    provider: ContextProviderName,
    operation: () => Promise<readonly ContextEvidence[]>
  ): Promise<ProviderResult> {
    const startedAt = performance.now();
    try {
      const evidence = await operation();
      return {
        provider,
        evidence,
        latencyMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100)
      };
    } catch (error) {
      throw new ContextProviderUnavailableError(provider, error);
    }
  }

  private toCoverage(result: ProviderResult): ProviderCoverage {
    return {
      queried: true,
      status: "ok",
      hits: result.evidence.length,
      latencyMs: result.latencyMs
    };
  }
}

function mergeEvidence(results: readonly ProviderResult[], maxItems: number): readonly ContextEvidence[] {
  const deduplicated = new Map<string, ContextEvidence>();

  for (const result of results) {
    for (const evidence of result.evidence) {
      const key = evidenceKey(evidence);
      const existing = deduplicated.get(key);
      if (!existing || compareEvidence(evidence, existing) < 0) {
        deduplicated.set(key, evidence);
      }
    }
  }

  const ranked = [...deduplicated.values()].sort(compareEvidence);
  const guaranteed = new Map<ContextProviderName, ContextEvidence>();
  for (const evidence of ranked) {
    if (!guaranteed.has(evidence.provider)) guaranteed.set(evidence.provider, evidence);
  }

  const selected = new Map<string, ContextEvidence>();
  for (const evidence of guaranteed.values()) selected.set(selectionKey(evidence), evidence);

  const effectiveLimit = Math.max(1, maxItems, guaranteed.size);
  for (const evidence of ranked) {
    if (selected.size >= effectiveLimit) break;
    selected.set(selectionKey(evidence), evidence);
  }

  return [...selected.values()].sort(compareEvidence);
}

function selectionKey(evidence: ContextEvidence): string {
  return `${evidence.provider}\u0000${evidence.id}`;
}

function evidenceKey(evidence: ContextEvidence): string {
  return [evidence.provider, evidence.path ?? "", evidence.symbol ?? "", evidence.content].join("\u0000");
}

function compareEvidence(left: ContextEvidence, right: ContextEvidence): number {
  const scoreDelta = (right.score ?? 0) - (left.score ?? 0);
  if (scoreDelta !== 0) return scoreDelta;

  const priorityDelta = PROVIDER_PRIORITY[right.provider] - PROVIDER_PRIORITY[left.provider];
  if (priorityDelta !== 0) return priorityDelta;

  return left.id.localeCompare(right.id);
}
