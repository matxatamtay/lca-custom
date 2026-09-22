import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPerformanceFollow } from "../../server/core/performance-follow.mjs";
import { createImprovementCandidateStore } from "../../server/core/self-improvement/improvement-candidate-store.mjs";
import {
  buildImprovementReport,
  createImproveCommand,
  renderImprovementReport,
  workspaceIdForRoot
} from "./improve-command.mjs";

test("analysis-only improve report merges performance, stored, and dependency candidates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-improve-root-"));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lca-improve-data-"));
  const workspaceData = path.join(dataDir, "workspaces", workspaceIdForRoot(root));
  await mkdir(workspaceData, { recursive: true });
  try {
    const follow = createPerformanceFollow({
      filePath: path.join(workspaceData, "performance-follow.json"),
      now: () => Date.now()
    });
    for (let index = 1; index <= 3; index += 1) {
      follow.recordToolCall({
        tool: "workspace_context",
        root,
        trace: { task_id: "task-" + index, task_class: "user" },
        durationMs: 1200 + index,
        success: true,
        result: {
          structuredContent: {
            coverage: {
              filesystem: { latencyMs: 10 },
              semantic: { latencyMs: 20 },
              codegraph: { latencyMs: 900, details: { index_ms: 500, query_ms: 400 } },
              agentmemory: { latencyMs: 30 }
            }
          }
        }
      });
    }
    await follow.flush();

    const store = createImprovementCandidateStore({
      jsonlPath: path.join(workspaceData, "improvement-candidates.jsonl"),
      statePath: path.join(workspaceData, "improvement-state.json")
    });
    await store.ingest([{
      source: ["semgrep"],
      category: "SECURITY",
      component: "security-test",
      affected_paths: ["src/a.ts"],
      evidence: { fingerprint: "security-1" },
      confidence: 1,
      impact: 0.8,
      frequency: 0.5,
      estimated_cost: 0.3,
      regression_probability: 1
    }]);

    await writeFile(path.join(root, "renovate-feed.json"), JSON.stringify({
      updates: [{
        package: "zod",
        from: "3.22.0",
        to: "3.23.0",
        update_type: "minor",
        affected_files: ["package.json"]
      }]
    }), "utf8");

    const report = await buildImprovementReport({ root, dataDir });
    assert.equal(report.mode, "analysis-only");
    assert.equal(report.analysis_only, true);
    assert.equal(report.mutation_allowed, false);
    assert.equal(report.secondary_model, false);
    assert.equal(report.dependency_feed.binary_executed, false);
    assert.ok(report.candidates.some((candidate) => candidate.category === "PERFORMANCE"));
    assert.ok(report.candidates.some((candidate) => candidate.category === "SECURITY"));
    assert.ok(report.candidates.some((candidate) => candidate.category === "DEPENDENCY"));

    const text = renderImprovementReport(report);
    assert.match(text, /LCA Improvement Report/);
    assert.match(text, /analysis-only/);
    assert.match(text, /No changes applied/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("CLI filters map to improvement categories without applying anything", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-improve-filter-"));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lca-improve-filter-data-"));
  const workspaceData = path.join(dataDir, "workspaces", workspaceIdForRoot(root));
  await mkdir(workspaceData, { recursive: true });
  try {
    const store = createImprovementCandidateStore({
      jsonlPath: path.join(workspaceData, "improvement-candidates.jsonl"),
      statePath: path.join(workspaceData, "improvement-state.json")
    });
    await store.ingest([
      candidate("DEPENDENCY", "dep"),
      candidate("TEST_QUALITY", "test"),
      candidate("SECURITY", "security")
    ]);

    let output = "";
    const { improveCommand } = createImproveCommand({
      repoRoot: path.resolve("."),
      dataDir,
      detectWorkspaceRoot: async () => root,
      output: { write(value) { output += String(value); } }
    });
    const report = await improveCommand([], { tests: true });
    assert.deepEqual(report.filters, ["tests"]);
    assert.ok(report.candidates.length > 0);
    assert.ok(report.candidates.every((item) => item.category === "TEST_QUALITY"));
    assert.match(output, /No changes applied/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("explicit apply refuses candidates without deterministic recipes before connecting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-improve-refuse-"));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lca-improve-refuse-data-"));
  const workspaceData = path.join(dataDir, "workspaces", workspaceIdForRoot(root));
  await mkdir(workspaceData, { recursive: true });
  const target = path.join(root, "target.txt");
  await writeFile(target, "unchanged\n", "utf8");
  try {
    const store = createImprovementCandidateStore({
      jsonlPath: path.join(workspaceData, "improvement-candidates.jsonl"),
      statePath: path.join(workspaceData, "improvement-state.json")
    });
    await store.ingest([candidate("PERFORMANCE", "no-recipe")]);
    const stored = await store.list({ limit: 10 });
    let connections = 0;
    let output = "";
    const { improveCommand } = createImproveCommand({
      repoRoot: path.resolve("."),
      dataDir,
      detectWorkspaceRoot: async () => root,
      output: { write(value) { output += String(value); } },
      createExecutionClient: async () => {
        connections += 1;
        throw new Error("must not connect");
      }
    });
    const result = await improveCommand([], { apply: stored[0].id });
    assert.equal(result.status, "refused");
    assert.equal(result.reason, "candidate_has_no_deterministic_execution_recipe");
    assert.equal(result.applied, false);
    assert.equal(connections, 0);
    assert.equal(await readFile(target, "utf8"), "unchanged\n");
    assert.match(output, /status: refused/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("explicit deterministic apply uses context, verified edit, and before/after benchmark only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-improve-apply-"));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lca-improve-apply-data-"));
  const workspaceData = path.join(dataDir, "workspaces", workspaceIdForRoot(root));
  await mkdir(workspaceData, { recursive: true });
  const target = path.join(root, "target.txt");
  await writeFile(target, "before\n", "utf8");
  try {
    const store = createImprovementCandidateStore({
      jsonlPath: path.join(workspaceData, "improvement-candidates.jsonl"),
      statePath: path.join(workspaceData, "improvement-state.json")
    });
    await store.ingest([{
      source: ["test"],
      category: "PERFORMANCE",
      component: "workspace_context",
      affected_paths: ["target.txt"],
      evidence: {
        fingerprint: "deterministic-demo",
        execution: {
          kind: "workspace_edit.apply_patch",
          operations: [{
            op: "update",
            path: "target.txt",
            edits: [{ old_text: "before", new_text: "after" }]
          }]
        }
      },
      confidence: 1,
      impact: 0.5,
      frequency: 0.5,
      estimated_cost: 0.2,
      regression_probability: 1
    }]);
    const stored = await store.list({ limit: 10 });
    const calls = [];
    let closed = false;
    let statusCalls = 0;
    let output = "";
    const fakeClient = {
      async callTool(input) {
        calls.push({ name: input.name, arguments: input.arguments });
        if (input.name === "workspace_context") {
          return {
            structuredContent: {
              contextId: "ctx-apply",
              root,
              coverage: { filesystem: { status: "ok" } }
            }
          };
        }
        if (input.name === "workspace_status") {
          statusCalls += 1;
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                tasks: 3,
                samples: 9,
                context_ms: statusCalls === 1
                  ? { p50_ms: 100, p95_ms: 200 }
                  : { p50_ms: 80, p95_ms: 150 },
                verification_ms: { p95_ms: 50 },
                workflow_efficiency: { failure_rate: 0 }
              })
            }]
          };
        }
        if (input.name === "workspace_edit" && input.arguments.action === "decision") {
          assert.equal(input.arguments.arguments.memory_kind, "accepted_improvement");
          assert.equal(input.arguments.arguments.memory.verdict, "improved");
          assert.equal(input.arguments.arguments.memory.regression, false);
          assert.match(input.arguments.arguments.memory.before, /"p95_ms":200/);
          assert.match(input.arguments.arguments.memory.after, /"p95_ms":150/);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ ok: true, root, memory_persisted: true })
            }]
          };
        }
        if (input.name === "workspace_edit") {
          const operation = input.arguments.arguments.operations[0];
          const current = await readFile(operation.path, "utf8");
          const edit = operation.edits[0];
          assert.ok(current.includes(edit.old_text));
          await writeFile(operation.path, current.replace(edit.old_text, edit.new_text), "utf8");
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ok: true,
                rollback_available: true,
                verification: { requested: true, ok: true, duration_ms: 1 }
              })
            }]
          };
        }
        throw new Error("unexpected tool " + input.name);
      },
      async close() { closed = true; }
    };

    const { improveCommand } = createImproveCommand({
      repoRoot: path.resolve("."),
      dataDir,
      detectWorkspaceRoot: async () => root,
      output: { write(value) { output += String(value); } },
      createExecutionClient: async () => fakeClient
    });
    const result = await improveCommand([], { apply: stored[0].id });
    assert.equal(result.status, "accepted");
    assert.equal(result.ok, true);
    assert.equal(result.evaluation.verdict, "improved");
    assert.equal(result.evaluation.before.p95_ms, 200);
    assert.equal(result.evaluation.after.p95_ms, 150);
    assert.equal(result.evaluation.regression, false);
    assert.equal(result.applied, true);
    assert.equal(result.secondary_model, false);
    assert.equal(result.commit_performed, false);
    assert.equal(result.push_performed, false);
    assert.equal(result.dependency_update_performed, false);
    assert.equal(result.improvement_memory.persisted, true);
    assert.equal(await readFile(target, "utf8"), "after\n");
    assert.equal(closed, true);
    assert.deepEqual(calls.map((call) => call.name), [
      "workspace_context",
      "workspace_status",
      "workspace_edit",
      "workspace_status",
      "workspace_edit"
    ]);
    assert.equal(calls.some((call) => call.name === "workspace_git"), false);
    assert.equal(calls.some((call) => call.name === "workspace_exec"), false);
    assert.equal(calls[2].arguments.action, "apply_patch");
    assert.equal(calls[2].arguments.arguments.verify, "changed");
    assert.equal(calls[4].arguments.action, "decision");
    assert.equal(calls[4].arguments.arguments.memory_kind, "accepted_improvement");
    assert.match(output, /verification: PASS/);
    assert.match(output, /evaluation: improved/);
    assert.match(output, /improvement memory: stored/);
    assert.match(output, /commit: no/);
    assert.match(output, /push: no/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("verified patch is automatically reverted when measurable improvement does not exceed noise", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-improve-no-gain-"));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lca-improve-no-gain-data-"));
  const workspaceData = path.join(dataDir, "workspaces", workspaceIdForRoot(root));
  await mkdir(workspaceData, { recursive: true });
  const target = path.join(root, "target.txt");
  await writeFile(target, "before\n", "utf8");
  try {
    const store = createImprovementCandidateStore({
      jsonlPath: path.join(workspaceData, "improvement-candidates.jsonl"),
      statePath: path.join(workspaceData, "improvement-state.json")
    });
    await store.ingest([{
      source: ["test"],
      category: "PERFORMANCE",
      component: "workspace_context",
      affected_paths: ["target.txt"],
      evidence: {
        fingerprint: "no-measurable-gain",
        execution: {
          kind: "workspace_edit.apply_patch",
          operations: [{
            op: "update",
            path: "target.txt",
            edits: [{ old_text: "before", new_text: "after" }]
          }]
        }
      },
      confidence: 1,
      impact: 0.6,
      frequency: 0.5,
      estimated_cost: 0.2,
      regression_probability: 1
    }]);
    const stored = await store.list({ limit: 10 });
    const calls = [];
    let output = "";
    const fakeClient = {
      async callTool(input) {
        calls.push({ name: input.name, arguments: input.arguments });
        if (input.name === "workspace_context") {
          return {
            structuredContent: {
              contextId: "ctx-no-gain",
              root,
              coverage: { filesystem: { status: "ok" } }
            }
          };
        }
        if (input.name === "workspace_status") {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                tasks: 3,
                samples: 9,
                context_ms: { p50_ms: 100, p95_ms: 200 },
                verification_ms: { p95_ms: 50 },
                workflow_efficiency: { failure_rate: 0 }
              })
            }]
          };
        }
        if (input.name === "workspace_edit" && input.arguments.action === "apply_patch") {
          const operation = input.arguments.arguments.operations[0];
          const current = await readFile(operation.path, "utf8");
          const edit = operation.edits[0];
          await writeFile(operation.path, current.replace(edit.old_text, edit.new_text), "utf8");
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ok: true,
                rollback_available: true,
                verification: { requested: true, ok: true, duration_ms: 1 }
              })
            }]
          };
        }
        if (input.name === "workspace_edit" && input.arguments.action === "undo") {
          await writeFile(target, "before\n", "utf8");
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ ok: true, tool: "apply_patch" })
            }]
          };
        }
        throw new Error("unexpected tool " + input.name);
      },
      async close() {}
    };

    const { improveCommand } = createImproveCommand({
      repoRoot: path.resolve("."),
      dataDir,
      detectWorkspaceRoot: async () => root,
      output: { write(value) { output += String(value); } },
      createExecutionClient: async () => fakeClient
    });
    const result = await improveCommand([], { apply: stored[0].id });
    assert.equal(result.status, "reverted_not_improved");
    assert.equal(result.ok, false);
    assert.equal(result.applied, false);
    assert.equal(result.reverted, true);
    assert.equal(result.reason, "evaluation_did_not_accept_patch");
    assert.equal(result.evaluation.verdict, "not_improved");
    assert.equal(result.evaluation.correctness_pass, true);
    assert.equal(result.evaluation.measurable, true);
    assert.equal(result.evaluation.before.p95_ms, 200);
    assert.equal(result.evaluation.after.p95_ms, 200);
    assert.equal(await readFile(target, "utf8"), "before\n");
    assert.deepEqual(calls.map((call) => call.name), [
      "workspace_context",
      "workspace_status",
      "workspace_edit",
      "workspace_status",
      "workspace_edit"
    ]);
    assert.equal(calls.at(-1).arguments.action, "undo");
    assert.equal(calls.some((call) => call.arguments?.arguments?.memory_kind === "accepted_improvement"), false);
    assert.equal(result.improvement_memory, undefined);
    assert.match(output, /evaluation: not_improved/);
    assert.match(output, /reverted: yes/);
    assert.match(output, /commit: no/);
    assert.match(output, /push: no/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

function candidate(category, component) {
  return {
    source: ["test"],
    category,
    component,
    affected_paths: [],
    evidence: { fingerprint: category + "-" + component },
    confidence: 1,
    impact: 0.5,
    frequency: 0.5,
    estimated_cost: 0.5,
    regression_probability: 1
  };
}
