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
      evidence: mergeEvidence(providerResults, normalizedRequest)
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

function mergeEvidence(results: readonly ProviderResult[], request: TaskContextRequest): readonly ContextEvidence[] {
  const maxItems = Math.max(1, request.budget?.maxItems ?? 50);
  const maxChars = Math.max(1_000, request.budget?.maxChars ?? 100_000);
  const taskTerms = extractTaskTerms(request.task);
  const graphHints = buildGraphHints(results);
  const changedFiles = new Set((request.changedFiles ?? []).map(normalizePath));
  const deduplicated = new Map<string, ContextEvidence>();

  for (const result of results) {
    for (const evidence of result.evidence) {
      const reranked = rerankEvidence(evidence, taskTerms, graphHints, changedFiles);
      const key = evidenceKey(reranked);
      const existing = deduplicated.get(key);
      if (!existing || compareEvidence(reranked, existing) < 0) {
        deduplicated.set(key, reranked);
      }
    }
  }

  const ranked = [...deduplicated.values()].sort(compareEvidence);
  const guaranteed = new Map<ContextProviderName, ContextEvidence>();
  for (const evidence of ranked) {
    if (!guaranteed.has(evidence.provider)) guaranteed.set(evidence.provider, evidence);
  }

  const selected = new Map<string, ContextEvidence>();
  const semanticSelected = new Set<string>();
  for (const evidence of guaranteed.values()) {
    selected.set(selectionKey(evidence), evidence);
    semanticSelected.add(semanticKey(evidence));
  }

  const effectiveLimit = Math.max(1, maxItems, guaranteed.size);
  const providerCaps = providerItemCaps(effectiveLimit);
  const providerCounts = new Map<ContextProviderName, number>();
  for (const evidence of selected.values()) {
    providerCounts.set(evidence.provider, (providerCounts.get(evidence.provider) ?? 0) + 1);
  }

  for (const evidence of ranked) {
    if (selected.size >= effectiveLimit) break;
    if (selected.has(selectionKey(evidence))) continue;
    if (semanticSelected.has(semanticKey(evidence))) continue;
    const currentCount = providerCounts.get(evidence.provider) ?? 0;
    if (currentCount >= providerCaps[evidence.provider]) continue;
    selected.set(selectionKey(evidence), evidence);
    semanticSelected.add(semanticKey(evidence));
    providerCounts.set(evidence.provider, currentCount + 1);
  }

  for (const evidence of ranked) {
    if (selected.size >= effectiveLimit) break;
    if (selected.has(selectionKey(evidence)) || semanticSelected.has(semanticKey(evidence))) continue;
    selected.set(selectionKey(evidence), evidence);
    semanticSelected.add(semanticKey(evidence));
  }

  return enforceCharBudget([...selected.values()].sort(compareEvidence), maxChars);
}

function selectionKey(evidence: ContextEvidence): string {
  return `${evidence.provider}\u0000${evidence.id}`;
}

function evidenceKey(evidence: ContextEvidence): string {
  return [evidence.provider, evidence.path ?? "", evidence.symbol ?? "", evidence.content].join("\u0000");
}

function semanticKey(evidence: ContextEvidence): string {
  return evidence.content
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

function compareEvidence(left: ContextEvidence, right: ContextEvidence): number {
  const scoreDelta = (right.score ?? 0) - (left.score ?? 0);
  if (scoreDelta !== 0) return scoreDelta;

  const priorityDelta = PROVIDER_PRIORITY[right.provider] - PROVIDER_PRIORITY[left.provider];
  if (priorityDelta !== 0) return priorityDelta;

  return left.id.localeCompare(right.id);
}

function rerankEvidence(
  evidence: ContextEvidence,
  taskTerms: readonly string[],
  graphHints: ReadonlySet<string>,
  changedFiles: ReadonlySet<string>
): ContextEvidence {
  let score = evidence.score ?? 0;
  const haystack = `${evidence.title}\n${evidence.content}`.toLowerCase();
  const evidencePath = normalizePath(evidence.path ?? "");
  for (const term of taskTerms) {
    if (haystack.includes(term)) score += 8;
    if (evidencePath.includes(term)) score += 12;
  }
  if (evidencePath && changedFiles.has(evidencePath)) score += 35;
  if (evidencePath && [...graphHints].some((hint) => evidencePath.endsWith(hint) || evidencePath.includes(`/${hint}`))) score += 30;
  if (evidence.provider === "agentmemory") score -= 5;
  return {
    ...evidence,
    score,
    metadata: { ...evidence.metadata, reranked_score: score }
  };
}

function buildGraphHints(results: readonly ProviderResult[]): ReadonlySet<string> {
  const hints = new Set<string>();
  const graph = results.find((result) => result.provider === "codegraph");
  for (const evidence of graph?.evidence ?? []) {
    if (evidence.path) hints.add(relativePathHint(evidence.path));
    for (const match of evidence.content.matchAll(/(?:^|[\s`'"(])([\w./-]+\.(?:ts|tsx|js|jsx|mjs|py|rs|go|java|kt|dart|swift|cs))(?:[:#]\d+)?/g)) {
      if (match[1]) hints.add(relativePathHint(match[1]));
    }
  }
  return hints;
}

function relativePathHint(value: string): string {
  return normalizePath(value).replace(/^.*?(?=(?:src|server|app|apps|packages|lib|test|tests)\/)/, "");
}

function extractTaskTerms(task: string): readonly string[] {
  const stop = new Set(["with", "from", "this", "that", "into", "then", "than", "when", "where", "what", "which", "implement", "support", "full", "current"]);
  const terms = new Set<string>();
  for (const raw of task.toLowerCase().match(/[\p{L}\p{N}_.$/-]+/gu) ?? []) {
    const value = raw.replace(/^[-./$]+|[-./$]+$/g, "");
    if (value.length < 3 || stop.has(value)) continue;
    terms.add(value);
    if (terms.size >= 16) break;
  }
  return [...terms];
}

function providerItemCaps(maxItems: number): Readonly<Record<ContextProviderName, number>> {
  return {
    filesystem: Math.max(1, Math.ceil(maxItems * 0.5)),
    codegraph: Math.max(1, Math.ceil(maxItems * 0.35)),
    agentmemory: Math.max(1, Math.ceil(maxItems * 0.2))
  };
}

function enforceCharBudget(evidence: readonly ContextEvidence[], maxChars: number): readonly ContextEvidence[] {
  const output: ContextEvidence[] = [];
  let remaining = maxChars;
  for (const item of evidence) {
    if (remaining <= 0) break;
    const fixedCost = item.title.length + (item.path?.length ?? 0) + 40;
    const available = Math.max(0, remaining - fixedCost);
    if (available <= 0 && output.length > 0) break;
    const content = item.content.slice(0, Math.max(0, available));
    output.push(content.length === item.content.length ? item : { ...item, content, metadata: { ...item.metadata, truncated: true } });
    remaining -= fixedCost + content.length;
  }
  return output;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}
