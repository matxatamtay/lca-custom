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
  ContextRerankerPort,
  FilesystemContextPort,
  MemoryPort,
  SemanticContextPort
} from "../../ports/context-providers.js";

interface ProviderResult {
  provider: ContextProviderName;
  evidence: readonly ContextEvidence[];
  latencyMs: number;
  status: ProviderCoverage["status"];
  details?: Readonly<Record<string, unknown>>;
}

export interface BuildTaskContextDependencies {
  filesystem: FilesystemContextPort;
  semantic: SemanticContextPort;
  codegraph: CodeIntelligencePort;
  agentmemory: MemoryPort;
  reranker?: ContextRerankerPort;
  now?: () => Date;
  createId?: () => string;
}

const PROVIDER_PRIORITY: Readonly<Record<ContextProviderName, number>> = {
  filesystem: 4,
  semantic: 3,
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

  private async runSemanticProvider(request: TaskContextRequest): Promise<ProviderResult> {
    const startedAt = performance.now();
    try {
      const result = await this.dependencies.semantic.context(request);
      const semanticState = result.state ?? (result.available ? "ready" : "unavailable");
      return {
        provider: "semantic",
        evidence: result.evidence,
        latencyMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
        status: semanticState === "ready" ? "ok" : semanticState,
        details: {
          language: result.language,
          engine: result.engine,
          available: result.available,
          state: semanticState,
          ...(result.reason ? { reason: result.reason } : {})
        }
      };
    } catch (error) {
      return {
        provider: "semantic",
        evidence: [],
        latencyMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
        status: "unavailable",
        details: {
          available: false,
          reason: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  async execute(request: TaskContextRequest): Promise<TaskContext> {
    const task = request.task.trim();
    if (!task) throw new Error("Task context requires a non-empty task.");

    const normalizedRequest: TaskContextRequest = { ...request, task };

    const [filesystem, semantic, codegraph, agentmemory] = await Promise.all([
      this.runProvider("filesystem", () => this.dependencies.filesystem.search(normalizedRequest)),
      this.runSemanticProvider(normalizedRequest),
      this.runCodegraphProvider(normalizedRequest),
      this.runProvider("agentmemory", () => this.dependencies.agentmemory.recall(normalizedRequest))
    ]);

    const providerResults = [filesystem, semantic, codegraph, agentmemory] as const;
    const coverage = Object.fromEntries(
      providerResults.map((result) => [result.provider, this.toCoverage(result)])
    ) as ContextCoverage;
    const reranked = await this.rerankEvidence(normalizedRequest, providerResults);

    return {
      contextId: this.createId(),
      task,
      root: normalizedRequest.root,
      generatedAt: this.now().toISOString(),
      coverage,
      evidence: mergeEvidence(reranked.results, normalizedRequest.budget?.maxItems ?? 50),
      ...(reranked.ranking ? { ranking: reranked.ranking } : {})
    };
  }

  private async rerankEvidence(
    request: TaskContextRequest,
    results: readonly ProviderResult[]
  ): Promise<{ results: readonly ProviderResult[]; ranking?: TaskContext["ranking"] }> {
    if (!this.dependencies.reranker) return { results };

    const original = results.flatMap((result) => result.evidence);
    const startedAt = performance.now();
    try {
      const reranked = await this.dependencies.reranker.rerank(request, original);
      const replacements = new Map(reranked.evidence.map((item) => [selectionKey(item), item]));
      const mappedResults = results.map((result) => ({
        ...result,
        evidence: result.evidence.map((item) => replacements.get(selectionKey(item)) ?? item)
      }));
      const pruned = pruneConfidentJevNoise(mappedResults, reranked.ranking);
      return {
        results: pruned.results,
        ranking: pruned.pruned > 0
          ? { ...reranked.ranking, pruned: pruned.pruned }
          : reranked.ranking
      };
    } catch {
      return {
        results,
        ranking: {
          provider: "rule",
          status: "fallback",
          latencyMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
          fallbackReason: "reranker-error"
        }
      };
    }
  }

  private async runCodegraphProvider(request: TaskContextRequest): Promise<ProviderResult> {
    const startedAt = performance.now();
    try {
      await this.dependencies.codegraph.ensureIndexed(request.root, request.changedFiles ?? []);
      const evidence = await this.dependencies.codegraph.context(request);
      const telemetry = this.dependencies.codegraph.telemetry?.(request.root);
      return {
        provider: "codegraph",
        evidence,
        latencyMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
        status: "ok",
        ...(telemetry ? { details: telemetry } : {})
      };
    } catch (error) {
      throw new ContextProviderUnavailableError("codegraph", error);
    }
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
        latencyMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
        status: "ok"
      };
    } catch (error) {
      throw new ContextProviderUnavailableError(provider, error);
    }
  }

  private toCoverage(result: ProviderResult): ProviderCoverage {
    return {
      queried: true,
      status: result.status,
      hits: result.evidence.length,
      latencyMs: result.latencyMs,
      ...(result.details ? { details: result.details } : {})
    };
  }
}

function pruneConfidentJevNoise(
  results: readonly ProviderResult[],
  ranking: NonNullable<TaskContext["ranking"]>
): { results: readonly ProviderResult[]; pruned: number } {
  if (ranking.provider !== "jev" || ranking.status !== "applied") {
    return { results, pruned: 0 };
  }

  let pruned = 0;
  const filtered = results.map((result) => ({
    ...result,
    evidence: result.evidence.filter((item) => {
      if (!isConfidentJevNoise(item)) return true;
      pruned += 1;
      return false;
    })
  }));
  return { results: filtered, pruned };
}

function isConfidentJevNoise(evidence: ContextEvidence): boolean {
  const metadata = evidence.metadata?.jevRerank;
  if (!metadata || typeof metadata !== "object") return false;
  const decision = metadata as { score?: unknown; confidence?: unknown };
  const score = typeof decision.score === "number" ? decision.score : Number(decision.score);
  const confidence = typeof decision.confidence === "number"
    ? decision.confidence
    : Number(decision.confidence);
  return score === 0 && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
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
