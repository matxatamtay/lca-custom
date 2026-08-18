import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCodeMode } from "../code-mode-runtime.mjs";
import { ActionExecutionPipeline } from "../dist/runtime/action-execution-pipeline.js";
import { RuntimeEventStore } from "../dist/runtime/runtime-event-store.js";
import { ConversationRuntimeContext } from "../dist/orchestration/conversation-runtime-context.js";

const root = await mkdtemp(path.join(os.tmpdir(), "lca-runtime-bench-"));
try {
  const store = new RuntimeEventStore({ path: path.join(root, "events.jsonl"), maxInMemory: 10_000 });
  await store.init();
  const pipeline = new ActionExecutionPipeline(store);

  for (let index = 0; index < 5; index += 1) {
    await pipeline.execute({ name: "warmup", surface: "runtime" }, () => index);
  }

  const startDelays = [];
  const ACTIONS = 80;
  const actionBatchStart = performance.now();
  for (let index = 0; index < ACTIONS; index += 1) {
    const callStart = performance.now();
    await pipeline.execute({ name: "bench/noop", surface: "runtime" }, () => {
      startDelays.push(performance.now() - callStart);
      return { index };
    });
  }
  const actionTotalMs = performance.now() - actionBatchStart;
  await store.flush();

  const context = new ConversationRuntimeContext({
    primaryRoot: root,
    roots: [root],
    runner: "codex",
    isolation: "worktree",
    networkAccess: true
  });
  const CONTEXT_RUNS = 10_000;
  const contextStart = performance.now();
  for (let index = 0; index < CONTEXT_RUNS; index += 1) {
    context.run({ correlationId: `corr-${index}` }, () => context.current().runner);
  }
  const contextTotalMs = performance.now() - contextStart;

  const CODE_CALLS = 8;
  const BACKEND_DELAY_MS = 25;
  const backend = async (action) => {
    await new Promise((resolve) => setTimeout(resolve, BACKEND_DELAY_MS));
    return { action };
  };
  const sequentialStart = performance.now();
  for (let index = 0; index < CODE_CALLS; index += 1) await backend(`read-${index}`);
  const sequentialMs = performance.now() - sequentialStart;
  const codeStart = performance.now();
  const codeResult = await runCodeMode({
    program: `
      const names = Array.from({ length: ${CODE_CALLS} }, (_, index) => 'read-' + index);
      return await Promise.all(names.map((name) => lca.read(name, {})));
    `,
    dispatch: (_facade, action) => backend(action)
  });
  const codeMs = performance.now() - codeStart;

  const metrics = {
    runtime_event_path: store.path,
    persisted_event_count: store.query({ limit: 10_000 }).length,
    action_count: ACTIONS,
    pipeline_total_ms: round(actionTotalMs),
    pipeline_avg_ms: round(actionTotalMs / ACTIONS),
    action_start_delay_p95_ms: round(percentile(startDelays, 0.95)),
    context_runs: CONTEXT_RUNS,
    context_avg_us: round((contextTotalMs * 1000) / CONTEXT_RUNS),
    code_mode: {
      calls: CODE_CALLS,
      sequential_ms: round(sequentialMs),
      code_mode_ms: round(codeMs),
      latency_improvement_pct: round(((sequentialMs - codeMs) / sequentialMs) * 100),
      result_count: Array.isArray(codeResult.value) ? codeResult.value.length : 0
    },
    rss_mb: round(process.memoryUsage().rss / (1024 * 1024))
  };
  const gates = {
    event_order_complete: metrics.persisted_event_count >= (ACTIONS + 5) * 2,
    action_start_p95_under_25ms: metrics.action_start_delay_p95_ms < 25,
    pipeline_avg_under_25ms: metrics.pipeline_avg_ms < 25,
    context_avg_under_100us: metrics.context_avg_us < 100,
    code_mode_improves_latency_15pct: metrics.code_mode.latency_improvement_pct >= 15,
    code_mode_result_complete: metrics.code_mode.result_count === CODE_CALLS
  };
  const ok = Object.values(gates).every(Boolean);
  console.log(JSON.stringify({ ok, metrics, gates }, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}
