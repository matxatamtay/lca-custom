import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { classifyCommandFamily, createPerformanceFollow } from "./performance-follow.mjs";

test("command family classification is useful without persisting raw command text", () => {
  assert.equal(classifyCommandFamily("npm run typecheck"), "npm:typecheck");
  assert.equal(classifyCommandFamily("flutter test test/widget_test.dart"), "flutter:test");
  assert.equal(classifyCommandFamily("dart analyze lib"), "dart:analyze");
  assert.equal(classifyCommandFamily("/usr/local/bin/custom-check --token SUPERSECRET"), "other:custom-check");
  assert.doesNotMatch(classifyCommandFamily("/usr/local/bin/custom-check --token SUPERSECRET"), /SUPERSECRET/);
});

test("records privacy-safe long-lived tool/provider/command timings with p50 p95 and bottlenecks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-follow-"));
  const file = path.join(root, "performance-follow.json");
  let now = 1_000;
  try {
    const follow = createPerformanceFollow({ filePath: file, now: () => now });
    await follow.load();
    const trace = {
      task_id: "task-1",
      task_class: "user",
      context_temperature: "cold",
      correlation_id: "corr-task-1",
      trace_id: "trace-task-1"
    };
    follow.recordToolCall({
      tool: "workspace_context",
      root: "/repo",
      trace,
      success: true,
      durationMs: 400,
      inChars: 120,
      outBytes: 4_000,
      result: {
        structuredContent: {
          coverage: {
            filesystem: { status: "ok", hits: 4, latencyMs: 40 },
            semantic: { status: "ok", hits: 2, latencyMs: 70 },
            codegraph: { status: "ok", hits: 1, latencyMs: 310, details: { index_ms: 250, query_ms: 60 } },
            agentmemory: { status: "ok", hits: 0, latencyMs: 90 }
          },
          ranking: {
            provider: "jev",
            status: "applied",
            latencyMs: 120,
            candidates: 12,
            accepted: 10,
            candidateCap: 24,
            stateChars: 12345,
            pruned: 3,
            sufficiency: "partial",
            sufficiencyConfidence: 0.84
          },
          evidence: [{ metadata: { cache_hit: false } }, { metadata: { cache_hit: true } }]
        }
      }
    });
    follow.recordRuntimeSpans({
      root: "/repo",
      trace,
      spans: [
        {
          name: "workspace_context.codegraph.ensure_index",
          surface: "runtime",
          correlationId: "corr-task-1",
          spanId: "span-index",
          parentSpanId: "span-context",
          startedAt: "1970-01-01T00:00:01.000Z",
          durationMs: 250,
          success: true
        },
        {
          name: "workspace_context.jev",
          surface: "runtime",
          correlationId: "corr-task-1",
          spanId: "span-jev",
          parentSpanId: "span-context",
          startedAt: "1970-01-01T00:00:01.010Z",
          durationMs: 120,
          success: true
        }
      ]
    });
    now += 100;
    follow.recordToolCall({
      tool: "workspace_exec",
      action: "many",
      root: "/repo",
      trace: { ...trace, context_temperature: "warm" },
      success: true,
      durationMs: 3_500,
      inChars: 200,
      outBytes: 500,
      result: {
        content: [{ type: "text", text: JSON.stringify({
          results: [
            {
              command: "npm run typecheck -- --token RAW_SECRET_SHOULD_NOT_PERSIST",
              duration_ms: 1_000,
              exit_code: 0,
              acceleration: { cache_hit: true, reusable: true }
            },
            {
              command: "flutter test test/widget_test.dart --dart-define=API_KEY=RAW_SECRET_SHOULD_NOT_PERSIST",
              duration_ms: 3_000,
              exit_code: 0,
              acceleration: { cache_hit: false, reusable: false }
            }
          ]
        }) }]
      }
    });
    await follow.flush();

    const report = follow.report({ root: "/repo", windowDays: 30, taskClass: "user" });
    assert.equal(report.tasks, 1);
    assert.equal(report.context_ms.p50_ms, 400);
    assert.equal(report.providers.find((item) => item.name === "codegraph")?.p95_ms, 310);
    assert.equal(report.codegraph.index_ms.p95_ms, 250);
    assert.equal(report.codegraph.query_ms.p95_ms, 60);
    assert.equal(report.commands.find((item) => item.name === "npm:typecheck")?.p50_ms, 1_000);
    assert.equal(report.commands.find((item) => item.name === "flutter:test")?.p95_ms, 3_000);
    assert.equal(report.bottlenecks[0].name, "workspace_exec:many");
    assert.ok(report.cache_efficiency.checks >= 3);
    assert.ok(report.cache_efficiency.hits >= 1);
    assert.equal(report.jev.samples, 1);
    assert.equal(report.jev.statuses["jev:applied"], 1);
    assert.equal(report.jev.sufficiency.partial, 1);
    assert.equal(report.jev.pruned, 3);
    assert.equal(report.jev.avg_candidate_cap, 24);
    assert.equal(report.jev.avg_state_chars, 12345);
    assert.equal(report.jev.avg_pruned, 3);
    assert.equal(report.jev.acceptance_rate, 0.833);
    assert.equal(report.search_efficiency.calls, 0);
    assert.equal(report.workflow_efficiency.roundtrips_per_task, 2);
    assert.equal(report.workflow_efficiency.bytes_to_model_per_task, 4_500);
    assert.equal(report.test_duration_ms.p95_ms, 3_000);
    assert.equal(report.codegraph.index_ms.calls, 1);
    assert.equal(report.provider_cache.codegraph.checks, 0);
    assert.equal(report.trace_attribution.workspace_context.spans, 2);
    assert.equal(report.trace_attribution.workspace_context.top_contributors[0].component, "codegraph.ensure_index");
    assert.equal(report.trace_attribution.workspace_context.top_contributors[0].p95_ms, 250);

    const taskReport = follow.report({
      root: "/repo",
      taskClass: "user",
      taskId: "task-1",
      includeTimeline: true
    });
    assert.equal(taskReport.task.correlation_id, "corr-task-1");
    assert.equal(taskReport.task.trace_id, "trace-task-1");
    const spanRow = taskReport.timeline.find((item) => item.kind === "span" && item.name === "workspace_context.jev");
    assert.equal(spanRow?.span_id, "span-jev");
    assert.equal(spanRow?.parent_span_id, "span-context");
    assert.equal(spanRow?.correlation_id, "corr-task-1");
    assert.equal(spanRow?.trace_id, "trace-task-1");

    const persisted = await readFile(file, "utf8");
    assert.doesNotMatch(persisted, /RAW_SECRET_SHOULD_NOT_PERSIST/);
    assert.doesNotMatch(persisted, /npm run typecheck/);
    assert.doesNotMatch(persisted, /flutter test test\/widget_test/);
    assert.match(persisted, /npm:typecheck/);
    assert.match(persisted, /flutter:test/);

    const restored = createPerformanceFollow({ filePath: file, now: () => now });
    await restored.load();
    const restoredReport = restored.report({ root: "/repo", taskClass: "user" });
    assert.equal(restoredReport.samples, report.samples);
    assert.equal(restoredReport.commands.find((item) => item.name === "flutter:test")?.p50_ms, 3_000);
    await restored.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("records structural-vs-text search timings by action for benchmark comparison", () => {
  let now = 5_000;
  const follow = createPerformanceFollow({ now: () => now++ });
  const trace = { task_id: "search-task", task_class: "user" };
  follow.recordToolCall({
    tool: "workspace_search",
    action: "text",
    root: "/repo",
    trace,
    durationMs: 12,
    success: true,
    result: {}
  });
  follow.recordToolCall({
    tool: "workspace_search",
    action: "ast",
    root: "/repo",
    trace,
    durationMs: 31,
    success: true,
    result: {}
  });
  const report = follow.report({ root: "/repo", taskClass: "user" });
  assert.equal(report.search_efficiency.calls, 2);
  assert.equal(report.search_efficiency.by_action.text.p50_ms, 12);
  assert.equal(report.search_efficiency.by_action.ast.p50_ms, 31);
});

test("Semgrep INFO findings are retained as aggregate telemetry without source content", () => {
  const follow = createPerformanceFollow({ now: () => 9_000 });
  follow.recordToolCall({
    tool: "workspace_verify",
    action: "semgrep_scan",
    root: "/repo",
    trace: { task_id: "semgrep-task", task_class: "user" },
    durationMs: 125,
    success: true,
    result: {
      structuredContent: {
        available: true,
        ok: true,
        summary: { findings: 4, error: 0, warning: 1, info: 3 },
        findings: [{ message: "RAW_FINDING_TEXT_SHOULD_NOT_PERSIST" }]
      }
    }
  });
  const report = follow.report({ root: "/repo", taskClass: "user" });
  assert.equal(report.semgrep.samples, 1);
  assert.equal(report.semgrep.findings.warning, 1);
  assert.equal(report.semgrep.findings.info, 3);
  assert.equal(report.semgrep.gate_failures, 0);
  assert.doesNotMatch(JSON.stringify(follow.report({ root: "/repo", taskClass: "user" })), /RAW_FINDING_TEXT_SHOULD_NOT_PERSIST/);
});

test("mutation telemetry persists aggregate score and counts without survivor payloads", () => {
  const follow = createPerformanceFollow({ now: () => 10_000 });
  follow.recordToolCall({
    tool: "workspace_verify",
    action: "mutation",
    root: "/repo",
    trace: { task_id: "mutation-task", task_class: "user" },
    durationMs: 500,
    success: true,
    result: {
      structuredContent: {
        available: true,
        ok: true,
        mode: "changed",
        telemetry: {
          mutants_total: 10,
          killed: 7,
          survived: 2,
          timeout: 1,
          no_coverage: 0,
          mutation_score: 80
        },
        surviving_mutants: [{ replacement: "RAW_MUTANT_PAYLOAD_SHOULD_NOT_PERSIST" }]
      }
    }
  });
  const report = follow.report({ root: "/repo", taskClass: "user" });
  assert.equal(report.mutation.samples, 1);
  assert.equal(report.mutation.mutants_total, 10);
  assert.equal(report.mutation.survived, 2);
  assert.equal(report.mutation.avg_score, 80);
  assert.equal(report.mutation.modes.changed, 1);
  assert.doesNotMatch(JSON.stringify(report), /RAW_MUTANT_PAYLOAD_SHOULD_NOT_PERSIST/);
});

test("reclassifies persisted samples from corrected telemetry task classes", () => {
  const follow = createPerformanceFollow({ now: () => 5_000 });
  follow.recordToolCall({
    tool: "workspace_context",
    root: "/repo",
    trace: { task_id: "smoke-1", task_class: "user", context_temperature: "cold" },
    durationMs: 25,
    success: true,
    result: {}
  });
  follow.recordToolCall({
    tool: "workspace_read",
    action: "one",
    root: "/repo",
    trace: { task_id: "smoke-1", task_class: "user" },
    durationMs: 5,
    success: true,
    result: {}
  });
  assert.equal(follow.report({ root: "/repo", taskClass: "user" }).samples, 2);
  assert.equal(follow.reclassifyTasks({ "smoke-1": "synthetic" }), 2);
  assert.equal(follow.report({ root: "/repo", taskClass: "user" }).samples, 0);
  assert.equal(follow.report({ root: "/repo", taskClass: "synthetic" }).samples, 2);
});

test("latest task zoom returns an ordered task timeline with Jev and prewarm context", () => {
  let now = 1_000;
  const follow = createPerformanceFollow({ now: () => now });
  follow.recordPrewarm({
    root: "/repo",
    projectRoot: "/repo/server",
    name: "context",
    durationMs: 80,
    success: true,
    providers: {
      codegraph: { status: "fulfilled", latencyMs: 60 },
      agentmemory: { status: "fulfilled", latencyMs: 30 },
      semantic: { status: "fulfilled", latencyMs: 20 }
    }
  });
  now += 20;
  follow.recordToolCall({
    tool: "workspace_context",
    root: "/repo",
    trace: { task_id: "task-a", task_class: "user", context_temperature: "warm" },
    durationMs: 120,
    outBytes: 3000,
    result: {
      structuredContent: {
        project_resolution: {
          workspace_root: "/repo",
          active_project_root: "/repo/server"
        },
        coverage: {
          filesystem: { status: "ok", hits: 2, latencyMs: 20 },
          semantic: { status: "ok", hits: 1, latencyMs: 25 },
          codegraph: {
            status: "ok",
            hits: 1,
            latencyMs: 75,
            details: { index_ms: 15, query_ms: 55, cache_hit: true, route: "search" }
          },
          agentmemory: { status: "ok", hits: 0, latencyMs: 10 }
        },
        evidence: [{ provider: "codegraph", metadata: { cache_hit: true } }],
        ranking: {
          provider: "jev",
          status: "applied",
          model: "jev-latest",
          latencyMs: 45,
          candidates: 4,
          accepted: 3,
          candidateCap: 16,
          stateChars: 4096,
          pruned: 1,
          sufficiency: "sufficient",
          sufficiencyConfidence: 0.92
        }
      }
    }
  });
  now += 50;
  follow.recordToolCall({
    tool: "workspace_read",
    action: "many",
    root: "/repo",
    trace: { task_id: "task-a", task_class: "user", context_temperature: "warm" },
    durationMs: 8,
    outBytes: 500,
    result: {}
  });
  now += 50;
  follow.recordToolCall({
    tool: "workspace_context",
    root: "/repo",
    trace: { task_id: "task-b", task_class: "user", context_temperature: "cold" },
    durationMs: 90,
    outBytes: 2000,
    result: { structuredContent: { coverage: {} } }
  });

  const report = follow.report({
    root: "/repo",
    taskClass: "user",
    latestTask: true,
    includeTimeline: true
  });

  assert.equal(report.query.task_id, "task-b");
  assert.equal(report.task.task_id, "task-b");
  assert.equal(report.latest_task_id, "task-b");
  assert.equal(report.timeline[0].name, "workspace_context");

  const taskA = follow.report({
    root: "/repo",
    taskClass: "user",
    taskId: "task-a",
    includeTimeline: true
  });
  assert.equal(taskA.task.tool_calls, 2);
  assert.equal(taskA.jev.models["jev-latest"], 1);
  assert.equal(taskA.provider_cache.codegraph.hit_ratio, 1);
  assert.equal(taskA.timeline.some((item) => item.kind === "ranking" && item.model === "jev-latest"), true);
  const ranking = taskA.timeline.find((item) => item.kind === "ranking");
  assert.equal(ranking?.candidate_cap, 16);
  assert.equal(ranking?.state_chars, 4096);
  assert.equal(taskA.timeline.find((item) => item.name === "workspace_context")?.prewarm_age_ms, 20);
  assert.equal(taskA.providers.find((item) => item.name === "codegraph")?.calls, 1);
  assert.equal(taskA.prewarm.providers.codegraph.attempts, 1);
  assert.equal(taskA.prewarm.providers.codegraph.failures, 0);
  assert.equal(taskA.prewarm.providers.codegraph.latency_ms.p50_ms, 60);
});

test("retention is bounded and reports filter cleanly by root and task class", () => {
  let now = 5_000;
  const follow = createPerformanceFollow({ now: () => now, maxSamples: 5 });
  const record = (root, taskClass, id, duration) => {
    follow.recordToolCall({
      tool: "workspace_read",
      action: "one",
      root,
      trace: { task_id: id, task_class: taskClass, context_temperature: "unknown" },
      durationMs: duration,
      success: true,
      result: {}
    });
    now += 1;
  };
  record("/a", "user", "u1", 10);
  record("/a", "internal", "i1", 20);
  record("/b", "user", "u2", 30);
  record("/a", "user", "u3", 40);
  record("/a", "user", "u4", 50);
  record("/a", "user", "u5", 60);
  record("/a", "user", "u6", 70);

  const all = follow.report({ taskClass: "all" });
  assert.equal(all.storage.retained_samples, 5);
  const repoUser = follow.report({ root: "/a", taskClass: "user" });
  assert.equal(repoUser.tools[0].calls, 4);
  assert.equal(repoUser.tools[0].p50_ms, 55);
  assert.equal(repoUser.tools[0].p95_ms, 68.5);
  assert.equal(repoUser.task_classes.user, 4);
  assert.equal(repoUser.task_classes.internal, undefined);
});
