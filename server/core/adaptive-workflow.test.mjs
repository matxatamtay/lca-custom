import assert from "node:assert/strict";
import test from "node:test";

import { buildAdaptiveWorkflow, performanceProfile } from "./adaptive-workflow.mjs";

const coverage = {
  filesystem: { status: "ok", hits: 5 },
  semantic: { status: "ok", hits: 2 },
  codegraph: { status: "ok", hits: 1 },
  agentmemory: { status: "ok", hits: 1 }
};
const reads = [{ path: "/repo/src/a.ts" }, { path: "/repo/src/b.ts" }];
const evidence = Array.from({ length: 5 }, (_, index) => ({ id: String(index) }));

test("high-signal implementation chooses one batch edit with fused changed verification", () => {
  const workflow = buildAdaptiveWorkflow({
    intent: "implement",
    root: "/repo",
    evidence,
    coverage,
    likelyReads: reads,
    verification: { gates: [{ name: "typecheck" }] },
    performance: {
      recent: [{ task_id: "old", root: "/repo", tool_roundtrips: 9, edits: 6, reads: 3, bytes_to_model: 20000 }]
    }
  });

  assert.equal(workflow.mode, "fast_path");
  assert.equal(workflow.roundtrip_target, 1);
  assert.deepEqual(workflow.recommended_calls, [{
    tool: "workspace_edit",
    action: "batch",
    verify: "changed",
    reason: "apply related edits transactionally and verify changed files in the same round-trip"
  }]);
  assert.ok(workflow.reasons.some((reason) => reason.startsWith("telemetry:high-roundtrips")));
  assert.ok(workflow.reasons.some((reason) => reason.startsWith("telemetry:batch-edits")));
});

test("debug and low-signal tasks inspect the smallest target set before batch editing", () => {
  const workflow = buildAdaptiveWorkflow({
    intent: "debug",
    root: "/repo",
    evidence: [{ id: "one" }],
    coverage: { ...coverage, filesystem: { status: "ok", hits: 1 } },
    likelyReads: reads,
    verification: { gates: [{ name: "test" }] }
  });

  assert.equal(workflow.mode, "inspect_first");
  assert.equal(workflow.roundtrip_target, 2);
  assert.equal(workflow.recommended_calls[0].tool, "workspace_read");
  assert.deepEqual(workflow.recommended_calls[0].paths, ["/repo/src/a.ts", "/repo/src/b.ts"]);
  assert.equal(workflow.recommended_calls[1].action, "batch");
});

test("performance profile is workspace-scoped, bounded, and deduplicates active/recent traces", () => {
  const shared = { task_id: "same", root: "/repo", tool_roundtrips: 8, edits: 4, reads: 2, bytes_to_model: 10000 };
  const profile = performanceProfile({
    recent: [{
      ...shared,
      task: "Fix retry flow",
      tools: { "workspace_search:text": { calls: 2 } }
    }, { task_id: "other-root", root: "/other", tool_roundtrips: 100, edits: 100, reads: 100 }],
    active: [shared, { task_id: "new", root: "/repo", tool_roundtrips: 4, edits: 2, reads: 0, bytes_to_model: 6000 }]
  }, "/repo", 8, "  fix   RETRY flow ");

  assert.equal(profile.samples, 2);
  assert.equal(profile.avg_roundtrips, 6);
  assert.equal(profile.avg_edits, 3);
  assert.equal(profile.avg_reads, 1);
  assert.equal(profile.avg_bytes_to_model, 8000);
  assert.equal(profile.same_task_contexts, 1);
  assert.equal(profile.same_task_reads, 2);
  assert.equal(profile.same_task_searches, 2);
  assert.equal(profile.same_task_edits, 4);
});

test("Jev sufficient context skips redundant reads for understand tasks", () => {
  const workflow = buildAdaptiveWorkflow({
    intent: "understand",
    root: "/repo",
    evidence,
    coverage,
    ranking: {
      provider: "jev",
      status: "applied",
      sufficiency: "sufficient",
      sufficiencyConfidence: 0.9
    },
    likelyReads: reads
  });

  assert.equal(workflow.mode, "context_ready");
  assert.deepEqual(workflow.recommended_calls, []);
  assert.ok(workflow.reasons.includes("jev:sufficiency:sufficient"));
});

test("Jev partial context forces targeted confirmation before implementation", () => {
  const workflow = buildAdaptiveWorkflow({
    intent: "implement",
    root: "/repo",
    evidence,
    coverage,
    ranking: {
      provider: "jev",
      status: "applied",
      sufficiency: "partial",
      sufficiencyConfidence: 0.8
    },
    likelyReads: reads,
    verification: { gates: [{ name: "typecheck" }] }
  });

  assert.equal(workflow.mode, "inspect_first");
  assert.equal(workflow.roundtrip_target, 2);
  assert.equal(workflow.recommended_calls[0].tool, "workspace_read");
  assert.equal(workflow.recommended_calls[1].tool, "workspace_edit");
  assert.ok(workflow.reasons.includes("jev:targeted-confirmation"));
});

test("Jev insufficient context blocks speculative implementation and retrieves more", () => {
  const workflow = buildAdaptiveWorkflow({
    intent: "implement",
    root: "/repo",
    evidence,
    coverage,
    ranking: {
      provider: "jev",
      status: "applied",
      sufficiency: "insufficient",
      sufficiencyConfidence: 0.95
    },
    likelyReads: reads
  });

  assert.equal(workflow.mode, "retrieve_more");
  assert.deepEqual(workflow.recommended_calls, [{
    tool: "workspace_search",
    action: "text",
    reason: "Jev says current context is insufficient; locate a stronger implementation target before editing"
  }]);
  assert.ok(workflow.reasons.includes("jev:retrieve-before-edit"));
});

test("loop guard skips a repeated read and moves partial implementation to edit", () => {
  const workflow = buildAdaptiveWorkflow({
    intent: "implement",
    task: "Fix retry flow",
    root: "/repo",
    evidence,
    coverage,
    ranking: {
      provider: "jev",
      status: "applied",
      sufficiency: "partial",
      sufficiencyConfidence: 0.85
    },
    likelyReads: reads,
    verification: { gates: [{ name: "typecheck" }] },
    performance: {
      recent: [{
        task_id: "previous",
        root: "/repo",
        task: "Fix retry flow",
        tool_roundtrips: 3,
        reads: 1,
        edits: 0,
        tools: {
          workspace_context: { calls: 1 },
          "workspace_read:many": { calls: 1 }
        }
      }]
    }
  });

  assert.equal(workflow.mode, "fast_path");
  assert.equal(workflow.recommended_calls.length, 1);
  assert.equal(workflow.recommended_calls[0].tool, "workspace_edit");
  assert.ok(workflow.reasons.includes("loop:avoid-repeat-read"));
  assert.equal(workflow.loop_guard.active, true);
  assert.equal(workflow.loop_guard.prior_reads, 1);
});

test("loop guard stops repeated broad retrieval when insufficient context is unchanged", () => {
  const workflow = buildAdaptiveWorkflow({
    intent: "understand",
    task: "Trace missing event",
    root: "/repo",
    evidence,
    coverage,
    ranking: {
      provider: "jev",
      status: "applied",
      sufficiency: "insufficient",
      sufficiencyConfidence: 0.9
    },
    likelyReads: reads,
    performance: {
      recent: [{
        task_id: "previous",
        root: "/repo",
        task: "Trace missing event",
        tool_roundtrips: 4,
        reads: 1,
        edits: 0,
        tools: {
          workspace_context: { calls: 1 },
          "workspace_search:text": { calls: 1 },
          "workspace_read:many": { calls: 1 }
        }
      }]
    }
  });

  assert.equal(workflow.mode, "context_stalled");
  assert.deepEqual(workflow.recommended_calls, []);
  assert.ok(workflow.reasons.includes("loop:retrieval-exhausted"));
  assert.equal(workflow.loop_guard.prior_searches, 1);
});

test("an intervening edit resets loop guard so rereads remain allowed", () => {
  const workflow = buildAdaptiveWorkflow({
    intent: "implement",
    task: "Fix retry flow",
    root: "/repo",
    evidence,
    coverage,
    ranking: {
      provider: "jev",
      status: "applied",
      sufficiency: "partial",
      sufficiencyConfidence: 0.85
    },
    likelyReads: reads,
    performance: {
      recent: [{
        task_id: "previous",
        root: "/repo",
        task: "Fix retry flow",
        tool_roundtrips: 4,
        reads: 1,
        edits: 1,
        tools: {
          workspace_context: { calls: 1 },
          "workspace_read:many": { calls: 1 },
          "workspace_edit:batch": { calls: 1 }
        }
      }]
    }
  });

  assert.equal(workflow.mode, "inspect_first");
  assert.equal(workflow.recommended_calls[0].tool, "workspace_read");
  assert.equal(workflow.loop_guard.active, false);
  assert.equal(workflow.loop_guard.reset_by_edit, true);
});
