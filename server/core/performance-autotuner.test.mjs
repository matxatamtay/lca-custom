import assert from "node:assert/strict";
import test from "node:test";

import { applyContextTuning, derivePerformanceTuning } from "./performance-autotuner.mjs";

function traces(root, count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    task_id: `${root}-${index}`,
    root,
    tool_roundtrips: 5,
    reads: 1,
    edits: 2,
    context_ms: 200,
    bytes_to_model: 20_000,
    cache: { hit_ratio: 0.6 },
    ...overrides
  }));
}

test("keeps conservative baseline until workspace telemetry is sufficient", () => {
  const tuning = derivePerformanceTuning({ recent: traces("/repo", 2) }, "/repo");
  assert.equal(tuning.mode, "baseline");
  assert.deepEqual(tuning.context, { max_items: 10, max_chars: 12_000 });
  assert.equal(tuning.metrics.samples, 2);
});

test("expands context modestly when repeated reads and round trips dominate", () => {
  const tuning = derivePerformanceTuning({
    recent: traces("/repo", 5, { tool_roundtrips: 9, reads: 4, bytes_to_model: 24_000 })
  }, "/repo");
  assert.equal(tuning.mode, "expand_context");
  assert.deepEqual(tuning.context, { max_items: 12, max_chars: 15_000 });
});

test("compacts context when model payload is high but follow-up reads are already low", () => {
  const tuning = derivePerformanceTuning({
    recent: traces("/repo", 4, { tool_roundtrips: 4, reads: 0, bytes_to_model: 70_000 })
  }, "/repo");
  assert.equal(tuning.mode, "compact_context");
  assert.deepEqual(tuning.context, { max_items: 8, max_chars: 9_000 });
});

test("explicit caller budgets always override telemetry tuning independently", () => {
  const tuning = { context: { max_items: 8, max_chars: 9_000 } };
  assert.deepEqual(applyContextTuning(tuning, { maxItems: 20 }), {
    maxItems: 20,
    maxChars: 9_000,
    explicit_overrides: { max_items: true, max_chars: false }
  });
  assert.deepEqual(applyContextTuning(tuning, { maxChars: 30_000 }), {
    maxItems: 8,
    maxChars: 30_000,
    explicit_overrides: { max_items: false, max_chars: true }
  });
});

test("excludes synthetic/internal traces from tuning and reports percentile hygiene", () => {
  const tuning = derivePerformanceTuning({
    recent: [
      ...traces("/repo", 4, { task_class: "synthetic", tool_roundtrips: 40, reads: 20, bytes_to_model: 200_000, context_temperature: "cold" }),
      ...traces("/repo", 3, { task_class: "user", tool_roundtrips: 4, reads: 1, bytes_to_model: 12_000, context_ms: 120, context_temperature: "warm" })
    ]
  }, "/repo", { now: Date.now() });
  assert.equal(tuning.mode, "baseline");
  assert.equal(tuning.metrics.samples, 3);
  assert.equal(tuning.metrics.p50_roundtrips, 4);
  assert.equal(tuning.metrics.warm_ratio, 1);
  assert.equal(tuning.hygiene.user_only, true);
});

test("age weighting reduces the influence of stale user traces without dropping them", () => {
  const now = 10 * 24 * 60 * 60_000;
  const recent = traces("/repo", 2, { task_class: "user", started_at: now, last_at: now, reads: 1, tool_roundtrips: 4 });
  const stale = traces("/repo", 1, { task_id: "/repo-stale", task_class: "user", started_at: 0, last_at: 0, reads: 20, tool_roundtrips: 30 });
  const tuning = derivePerformanceTuning({ recent: [...stale, ...recent] }, "/repo", { now, halfLifeMs: 24 * 60 * 60_000 });
  assert.equal(tuning.metrics.samples, 3);
  assert.ok(tuning.metrics.avg_reads < 3);
  assert.ok(tuning.metrics.effective_samples < 3);
});

test("autotuning remains scoped to the requested workspace", () => {
  const tuning = derivePerformanceTuning({
    recent: [
      ...traces("/other", 6, { tool_roundtrips: 20, reads: 10, bytes_to_model: 100_000 }),
      ...traces("/repo", 3, { tool_roundtrips: 4, reads: 1, bytes_to_model: 10_000 })
    ]
  }, "/repo");
  assert.equal(tuning.mode, "baseline");
  assert.equal(tuning.metrics.samples, 3);
});
