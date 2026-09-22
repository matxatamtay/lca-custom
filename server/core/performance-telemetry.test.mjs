import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { classifyTelemetryTask, createPerformanceTelemetry, modelVisibleResultBytes, telemetryPathCandidates } from "./performance-telemetry.mjs";

test("extracts operation paths for telemetry root routing and measures structured payload bytes", () => {
  const candidates = telemetryPathCandidates({
    action: "apply_patch",
    arguments: {
      operations: [{ op: "update", path: "/repo/server/a.ts", rename_to: "/repo/server/b.ts" }]
    }
  }, {});
  assert.deepEqual(candidates.slice(0, 2), ["/repo/server/a.ts", "/repo/server/b.ts"]);

  const result = {
    content: [{ type: "text", text: "ok" }],
    structuredContent: { evidence: [{ content: "structured payload" }] }
  };
  assert.equal(modelVisibleResultBytes(result), Buffer.byteLength(JSON.stringify({
    content: result.content,
    structuredContent: result.structuredContent
  }), "utf8"));
  assert.ok(modelVisibleResultBytes(result) > 2);
});

test("labels synthetic/internal/user tasks and classifies cold/warm context traces", () => {
  assert.equal(classifyTelemetryTask("LIVE_M13 benchmark daemon"), "synthetic");
  assert.equal(classifyTelemetryTask("Trace performanceFollow flow; LIVE synthetic smoke for router"), "synthetic");
  assert.equal(classifyTelemetryTask("Trace performanceFollow flow; BENCH_router-v2"), "synthetic");
  assert.equal(classifyTelemetryTask("Implement M23 in lca-custom"), "internal");
  assert.equal(classifyTelemetryTask("Fix promotion banner retry bug"), "user");

  let id = 0;
  const telemetry = createPerformanceTelemetry({ createId: () => String(++id), now: () => 1_000 });
  telemetry.recordToolCall({
    tool: "workspace_context", root: "/repo", task: "Fix promotion banner retry bug", durationMs: 100, result: {
      structuredContent: { evidence: [{ metadata: { cache_hit: false } }, { metadata: { cache_hit: false } }] }
    }
  });
  telemetry.recordToolCall({
    tool: "workspace_context", root: "/repo", task: "Fix promotion banner retry bug again", durationMs: 20, result: {
      structuredContent: { evidence: [{ metadata: { cache_hit: true } }, { metadata: { cache_hit: true } }] }
    }
  });
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.recent[0].task_class, "user");
  assert.equal(snapshot.recent[0].context_temperature, "cold");
  assert.equal(snapshot.active[0].context_temperature, "warm");
  assert.equal(snapshot.workload.classes.user, 2);
  assert.equal(snapshot.workload.context_temperature.cold, 1);
  assert.equal(snapshot.workload.context_temperature.warm, 1);
  assert.equal(snapshot.aggregate.context_ms.p50, 60);
  assert.equal(snapshot.aggregate.context_ms.p95, 96);
});

test("tracks one model-facing task across context, read, fused patch verification, and cache signals", () => {
  let id = 0;
  let now = 1_000;
  const telemetry = createPerformanceTelemetry({ now: () => now, createId: () => String(++id) });

  telemetry.recordToolCall({
    tool: "workspace_context",
    root: "/repo",
    task: "fix retry",
    correlationId: "corr-task-1",
    traceId: "trace-task-1",
    durationMs: 120,
    outChars: 8_000,
    result: {
      structuredContent: {
        project_resolution: {
          workspace_root: "/repo",
          active_project_root: "/repo/server"
        },
        coverage: {
          filesystem: { status: "ok", hits: 4, latencyMs: 30 },
          semantic: { status: "ok", hits: 2, latencyMs: 40 },
          codegraph: { status: "ok", hits: 1, latencyMs: 90 },
          agentmemory: { status: "ok", hits: 1, latencyMs: 50 }
        },
        ranking: {
          provider: "jev",
          status: "applied",
          latencyMs: 85.4,
          candidates: 8,
          accepted: 7,
          pruned: 2,
          sufficiency: "sufficient",
          sufficiencyConfidence: 0.91
        },
        evidence: [{ metadata: { cache_hit: true } }, { metadata: { cache_hit: false } }]
      }
    }
  });
  now += 10;
  telemetry.recordToolCall({ tool: "workspace_read", action: "read_many", root: "/repo", durationMs: 15, outChars: 2_000, result: {} });
  now += 10;
  telemetry.recordToolCall({
    tool: "workspace_edit",
    action: "apply_patch",
    root: "/repo",
    durationMs: 80,
    outChars: 1_000,
    result: { structuredContent: { verification: { duration_ms: 30, ok: true }, post_edit: { cache_hit: true } } }
  });

  const active = telemetry.snapshot().active[0];
  assert.equal(active.task_id, "task-1");
  assert.equal(active.correlation_id, "corr-task-1");
  assert.equal(active.trace_id, "trace-task-1");
  assert.deepEqual(telemetry.activeIdentity("/repo"), {
    task_id: "task-1",
    correlation_id: "corr-task-1",
    trace_id: "trace-task-1",
    root: "/repo"
  });
  assert.equal(active.tool_roundtrips, 3);
  assert.equal(active.bytes_to_model, 11_000);
  assert.equal(active.context_ms, 120);
  assert.equal(active.context_root, "/repo/server");
  assert.equal(active.reads, 1);
  assert.equal(active.patches, 1);
  assert.equal(active.patch_ms, 50);
  assert.equal(active.verification_ms, 30);
  assert.equal(active.providers.codegraph.latency_ms, 90);
  assert.equal(active.cache.hits, 2);
  assert.equal(active.cache.checks, 3);
  assert.equal(active.ranking.provider, "jev");
  assert.equal(active.ranking.sufficiency, "sufficient");
  assert.equal(active.ranking.pruned, 2);
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.aggregate.jev.applied, 1);
  assert.equal(snapshot.aggregate.jev.total_pruned, 2);
  assert.equal(snapshot.aggregate.jev.sufficiency.sufficient, 1);
  assert.equal(snapshot.workload.user_tasks.jev.avg_pruned, 2);
});

test("tracks search round-trips separately so search-heavy tasks are visible", () => {
  const telemetry = createPerformanceTelemetry({ createId: () => "search-heavy", now: () => 1_000 });
  telemetry.recordToolCall({ tool: "workspace_context", root: "/repo", task: "trace retry", result: {} });
  telemetry.recordToolCall({ tool: "workspace_search", action: "text", root: "/repo", durationMs: 20, result: {} });
  telemetry.recordToolCall({ tool: "workspace_search", action: "text", root: "/repo", durationMs: 22, result: {} });

  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.active[0].searches, 2);
  assert.equal(snapshot.aggregate.avg_searches, 2);
});

test("parses compact facade JSON text so fused verification time and cache signals are attributed", () => {
  const telemetry = createPerformanceTelemetry({ createId: () => "compact-json", now: () => 1_000 });
  telemetry.recordToolCall({ tool: "workspace_context", root: "/repo", task: "fused", result: {} });
  telemetry.recordToolCall({
    tool: "workspace_edit",
    action: "apply_patch",
    root: "/repo",
    durationMs: 80,
    outChars: 500,
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          verification: { duration_ms: 30, ok: true, roots: [{ prefetch: { cache_hit: true } }] }
        })
      }]
    }
  });

  const active = telemetry.snapshot().active[0];
  assert.equal(active.verification_ms, 30);
  assert.equal(active.patch_ms, 50);
  assert.equal(active.cache.hits, 1);
  assert.equal(active.cache.checks, 1);
});

test("new workspace_context supersedes only the active trace for the same root", () => {
  let id = 0;
  let now = 100;
  const telemetry = createPerformanceTelemetry({ now: () => now, createId: () => String(++id) });
  telemetry.recordToolCall({ tool: "workspace_context", root: "/a", task: "a1", result: {} });
  telemetry.recordToolCall({ tool: "workspace_context", root: "/b", task: "b1", result: {} });
  now = 200;
  telemetry.recordToolCall({ tool: "workspace_context", root: "/a", task: "a2", result: {} });

  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.active.length, 2);
  assert.equal(snapshot.aggregate.tasks, 3);
  const oldA = snapshot.recent.find((trace) => trace.task === "a1");
  const newA = snapshot.active.find((trace) => trace.root === "/a");
  assert.equal(oldA.ended_at, 200);
  assert.equal(newA.task, "a2");
});

test("persists bounded task traces and restores them after restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-perf-"));
  const file = path.join(root, "performance.json");
  try {
    const first = createPerformanceTelemetry({ filePath: file, createId: () => "persisted", now: () => 1_000 });
    await first.load();
    first.recordToolCall({ tool: "workspace_context", root: "/repo", task: "persist me", durationMs: 42, outChars: 123, result: {} });
    await first.flush();

    const second = createPerformanceTelemetry({ filePath: file });
    const restored = await second.load();
    assert.equal(restored.aggregate.tasks, 1);
    assert.equal(restored.active[0].task_id, "task-persisted");
    assert.equal(restored.active[0].context_ms, 42);
    assert.equal(restored.active[0].bytes_to_model, 123);
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
