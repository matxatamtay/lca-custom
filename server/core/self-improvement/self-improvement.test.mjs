import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBaselineStore } from "./baseline-store.mjs";
import { normalizeCandidate } from "./candidate-schema.mjs";
import { rankCandidates } from "./candidate-scorer.mjs";
import { createImprovementCandidateStore } from "./improvement-candidate-store.mjs";
import { collectImprovementMetrics, detectPerformanceCandidates } from "./improvement-metrics.mjs";

const report = {
  tasks: 10,
  samples: 100,
  context_ms: { calls: 10, p50_ms: 600, p95_ms: 1_100, avg_ms: 650, max_ms: 1_300, failures: 0 },
  trace_attribution: {
    workspace_context: {
      top_contributors: [
        { component: "jev", calls: 10, p95_ms: 401, total_ms: 3_100, share_of_parent_p95: 0.365 },
        { component: "codegraph.query", calls: 10, p95_ms: 117, total_ms: 900, share_of_parent_p95: 0.106 }
      ]
    }
  },
  jev: { latency_ms: { calls: 10, p50_ms: 300, p95_ms: 500, avg_ms: 320, max_ms: 600, failures: 0 } },
  codegraph: {
    index_ms: { calls: 10, p50_ms: 200, p95_ms: 700, avg_ms: 250, max_ms: 800, failures: 0 },
    query_ms: { calls: 10, p50_ms: 40, p95_ms: 90, avg_ms: 45, max_ms: 100, failures: 0 }
  },
  search_efficiency: { calls_per_task: 5.2 },
  workflow_efficiency: {
    tool_calls: 80,
    roundtrips_per_task: 8,
    read_calls_per_task: 7.5,
    bytes_to_model_per_task: 42_000,
    failure_rate: 0.05
  },
  verification_ms: { calls: 6, p50_ms: 1_000, p95_ms: 2_500, avg_ms: 1_200, max_ms: 3_000, failures: 0 },
  test_duration_ms: { calls: 3, p50_ms: 8_000, p95_ms: 12_000, avg_ms: 9_000, max_ms: 13_000, failures: 0 },
  cache_efficiency: { checks: 20, hit_ratio: 0.3 }
};

test("candidate normalization and scoring are deterministic", () => {
  const candidate = normalizeCandidate({
    category: "performance",
    component: "jev",
    affected_paths: ["b.ts", "a.ts", "a.ts"],
    evidence: { fingerprint: "jev:p95", p95_ms: 500 },
    source: ["performance_follow"],
    confidence: 0.9,
    impact: 0.8,
    frequency: 0.7,
    estimated_cost: 0.4
  });
  const again = normalizeCandidate({
    ...candidate,
    id: undefined,
    fingerprint: undefined,
    affected_paths: ["a.ts", "b.ts"]
  });
  assert.equal(candidate.fingerprint, again.fingerprint);
  assert.deepEqual(candidate.affected_paths, ["a.ts", "b.ts"]);

  const ranked = rankCandidates([
    candidate,
    { ...candidate, id: "low", fingerprint: "low", impact: 0.1 }
  ]);
  assert.equal(ranked[0].id, candidate.id);
  assert.ok(ranked[0].score > ranked[1].score);
});

test("performance rollups become canonical metrics and evidence-driven candidates", () => {
  const metrics = collectImprovementMetrics(report);
  assert.equal(metrics.workspace_context.p95_ms, 1_100);
  assert.equal(metrics.read_calls_per_task, 7.5);
  assert.equal(metrics.cache_hit_ratio, 0.3);

  const candidates = detectPerformanceCandidates({ metrics, report, root: "/repo" });
  const contextCandidate = candidates.find((candidate) => candidate.component === "workspace_context");
  assert.ok(contextCandidate);
  assert.equal(contextCandidate.evidence.attribution[0].component, "jev");
  assert.equal(contextCandidate.evidence.attribution[0].p95_ms, 401);
  assert.ok(candidates.some((candidate) => candidate.component === "jev"));
  assert.ok(candidates.some((candidate) => candidate.component === "codegraph:index"));
  assert.ok(candidates.some((candidate) => candidate.component === "workspace_search"));
  assert.ok(candidates.some((candidate) => candidate.category === "RELIABILITY"));
});

test("baseline store is reproducible and candidate store deduplicates append-only records", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-self-improvement-"));
  try {
    let now = 1_000;
    const baselinePath = path.join(dir, "improvement-baseline.json");
    const baselineStore = createBaselineStore({ filePath: baselinePath, now: () => now++ });
    const metrics = collectImprovementMetrics(report);
    const first = await baselineStore.capture({ root: "/repo", query: { window_days: 30 }, metrics });
    const second = await baselineStore.capture({ root: "/repo", query: { window_days: 30 }, metrics });
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(first.baseline.id, second.baseline.id);

    const candidateStore = createImprovementCandidateStore({
      jsonlPath: path.join(dir, "improvement-candidates.jsonl"),
      statePath: path.join(dir, "improvement-state.json"),
      now: () => now++
    });
    const candidates = detectPerformanceCandidates({ metrics, report, root: "/repo" });
    const ingestA = await candidateStore.ingest(candidates);
    const ingestB = await candidateStore.ingest(candidates);
    assert.ok(ingestA.added > 0);
    assert.equal(ingestB.added, 0);
    assert.equal(ingestB.existing, candidates.length);

    const lines = (await readFile(path.join(dir, "improvement-candidates.jsonl"), "utf8"))
      .trim().split("\n");
    assert.equal(lines.length, ingestA.added);
    const stored = await candidateStore.list({ limit: 100 });
    assert.equal(stored.length, ingestA.total);
    assert.ok(stored.every((candidate) => candidate.observations === 2));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
