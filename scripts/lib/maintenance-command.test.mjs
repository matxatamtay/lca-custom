import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runMaintenanceSweep,
  safeApplyEligibility,
  selectSafeCandidate
} from "./maintenance-command.mjs";
import {
  createImproveCommand,
  executeImprovementCandidate
} from "./improve-command.mjs";

test("maintenance sweep aggregates existing sensors without mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-maintenance-"));
  const calls = [];
  try {
    const client = {
      async callTool(input) {
        calls.push(input);
        return sensorResult(input, root, [rawCandidate({
          component: "cache",
          category: "PERFORMANCE"
        })]);
      }
    };

    const report = await runMaintenanceSweep({
      root,
      client,
      offlineCandidates: [rawCandidate({
        component: "workspace_context",
        category: "PERFORMANCE"
      })],
      limit: 10
    });

    assert.equal(report.mode, "analysis-only");
    assert.equal(report.analysis_only, true);
    assert.equal(report.mutation_allowed, false);
    assert.equal(report.secondary_model, false);
    assert.equal(report.commit_performed, false);
    assert.equal(report.push_performed, false);
    assert.equal(report.sensors.performance_history.available, true);
    assert.equal(report.sensors.semgrep.available, true);
    assert.equal(report.sensors.mutation.available, true);
    assert.equal(report.sensors.dependencies.available, true);
    assert.equal(report.sensors.ast_grep.available, true);
    assert.equal(report.sensors.cache_behavior.hit_ratio, 0.5);
    assert.equal(report.sensors.jev_behavior.latency_ms.p95_ms, 120);
    assert.equal(report.sensors.codegraph_behavior.query_ms.p95_ms, 35);
    assert.ok(report.candidates.length >= 2);
    assert.equal(calls.some((call) => call.name === "workspace_edit"), false);
    assert.equal(calls.some((call) => call.name === "workspace_git"), false);
    assert.equal(calls.some((call) => call.name === "workspace_exec"), false);
    assert.ok(calls.some((call) => call.name === "workspace_verify" && call.arguments.action === "semgrep_scan"));
    assert.ok(calls.some((call) => call.name === "workspace_verify" && call.arguments.action === "mutation_test"));
    assert.ok(calls.some((call) => call.name === "workspace_status" && call.arguments.action === "dependency_feed"));
    assert.ok(calls.some((call) => call.name === "workspace_search" && call.arguments.action === "ast_search"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe apply eligibility is explicit, low-risk, bounded, and never architectural", () => {
  const root = path.resolve("/tmp/lca-maintenance-safe");
  const safe = safeCandidate({
    root,
    safeClass: "deterministic_codemod"
  });
  assert.equal(safeApplyEligibility(safe, root).eligible, true);
  assert.equal(selectSafeCandidate([unsafeCandidate(root), safe], root)?.candidate, safe);

  const architecture = safeCandidate({
    root,
    safeClass: "deterministic_codemod",
    execution: { architectural_redesign: true }
  });
  assert.equal(safeApplyEligibility(architecture, root).reason, "architectural_redesign_forbidden");

  const highRisk = safeCandidate({
    root,
    safeClass: "format_config_cleanup",
    execution: { risk: "high" }
  });
  assert.equal(safeApplyEligibility(highRisk, root).reason, "candidate_not_explicitly_low_risk");

  const regressionWithoutRule = safeCandidate({
    root,
    safeClass: "known_regression_fix"
  });
  assert.equal(
    safeApplyEligibility(regressionWithoutRule, root).reason,
    "known_regression_fix_requires_rule_reference"
  );

  const majorDependency = safeCandidate({
    root,
    category: "DEPENDENCY",
    safeClass: "patch_dependency_update",
    evidence: {
      risk: "high",
      risk_metadata: { update_type: "major" }
    },
    execution: { full_green_gate: true }
  });
  assert.equal(
    safeApplyEligibility(majorDependency, root).reason,
    "dependency_update_not_patch_level_low_risk"
  );

  const patchDependency = safeCandidate({
    root,
    category: "DEPENDENCY",
    safeClass: "patch_dependency_update",
    evidence: {
      risk: "low",
      risk_metadata: { update_type: "patch" }
    },
    execution: { full_green_gate: true }
  });
  assert.equal(safeApplyEligibility(patchDependency, root).eligible, true);
  assert.equal(safeApplyEligibility(patchDependency, root).requires_full_green_gate, true);
});

test("--apply-safe makes no mutation when maintenance finds no eligible candidate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-maintenance-none-"));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lca-maintenance-none-data-"));
  const calls = [];
  let clients = 0;
  try {
    const { improveCommand } = createImproveCommand({
      repoRoot: path.resolve("."),
      dataDir,
      detectWorkspaceRoot: async () => root,
      output: { write() {} },
      createExecutionClient: async () => {
        clients += 1;
        return {
          async callTool(input) {
            calls.push(input);
            return sensorResult(input, root, [unsafeCandidate(root)]);
          },
          async close() {}
        };
      }
    });

    const result = await improveCommand([], { maintenance: true, applySafe: true });
    assert.equal(result.mode, "maintenance-apply-safe");
    assert.equal(result.analysis_only, false);
    assert.equal(result.mutation_allowed, true);
    assert.equal(result.apply_safe.status, "none_eligible");
    assert.equal(result.apply_safe.selected_candidate_id, null);
    assert.equal(clients, 1, "no second execution client should be created without an eligible candidate");
    assert.equal(calls.some((call) => call.name === "workspace_edit"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("--apply-safe delegates one eligible candidate to the verified evaluator path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-maintenance-apply-"));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lca-maintenance-apply-data-"));
  const target = path.join(root, "target.txt");
  await writeFile(target, "before\n", "utf8");
  const safe = safeCandidate({
    root,
    safeClass: "deterministic_codemod"
  });
  const calls = [];
  let clients = 0;
  let statusCalls = 0;
  try {
    const { improveCommand } = createImproveCommand({
      repoRoot: path.resolve("."),
      dataDir,
      detectWorkspaceRoot: async () => root,
      output: { write() {} },
      createExecutionClient: async () => {
        clients += 1;
        if (clients === 1) {
          return {
            async callTool(input) {
              calls.push({ phase: "sweep", ...input });
              return sensorResult(input, root, [safe]);
            },
            async close() {}
          };
        }
        return {
          async callTool(input) {
            calls.push({ phase: "apply", ...input });
            if (input.name === "workspace_context") {
              return {
                structuredContent: {
                  contextId: "ctx-safe",
                  root,
                  coverage: { filesystem: { status: "ok" } }
                }
              };
            }
            if (input.name === "workspace_status" && input.arguments.action === "performance") {
              statusCalls += 1;
              return jsonToolResult({
                tasks: 3,
                samples: 9,
                context_ms: statusCalls === 1
                  ? { p50_ms: 100, p95_ms: 200 }
                  : { p50_ms: 80, p95_ms: 150 },
                verification_ms: { p95_ms: 20 },
                workflow_efficiency: { failure_rate: 0 }
              });
            }
            if (input.name === "workspace_edit" && input.arguments.action === "apply_patch") {
              return jsonToolResult({
                ok: true,
                rollback_available: true,
                verification: { requested: true, ok: true, duration_ms: 1 }
              });
            }
            if (input.name === "workspace_edit" && input.arguments.action === "decision") {
              return jsonToolResult({ ok: true, root, memory_persisted: true });
            }
            throw new Error("unexpected apply tool " + input.name + ":" + input.arguments?.action);
          },
          async close() {}
        };
      }
    });

    const result = await improveCommand([], { maintenance: true, applySafe: true });
    assert.equal(clients, 2);
    assert.equal(result.mode, "maintenance-apply-safe");
    assert.equal(result.analysis_only, false);
    assert.equal(result.apply_safe.status, "accepted");
    assert.equal(result.apply_safe.execution.evaluation.verdict, "improved");
    assert.equal(result.apply_safe.execution.improvement_memory.persisted, true);
    const applyCalls = calls.filter((call) => call.phase === "apply");
    assert.ok(applyCalls.some((call) => call.name === "workspace_edit" && call.arguments.action === "apply_patch"));
    assert.ok(applyCalls.some((call) => call.name === "workspace_edit" && call.arguments.action === "decision"));
    assert.equal(applyCalls.some((call) => call.name === "workspace_git"), false);
    assert.equal(applyCalls.some((call) => call.name === "workspace_exec"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("safe patch dependency requires a real full green gate and rolls back when it fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-maintenance-dependency-"));
  const dependency = safeCandidate({
    root,
    category: "DEPENDENCY",
    safeClass: "patch_dependency_update",
    evidence: {
      from: "1.2.3",
      to: "1.2.4",
      risk: "low",
      risk_metadata: { update_type: "patch" }
    },
    execution: { full_green_gate: true }
  });
  const calls = [];
  try {
    const result = await executeImprovementCandidate({
      root,
      candidateId: "dependency-safe",
      candidate: {
        ...dependency,
        id: "dependency-safe"
      },
      createExecutionClient: async () => ({
        async callTool(input) {
          calls.push(input);
          if (input.name === "workspace_context") {
            return { structuredContent: { contextId: "dependency", root, coverage: {} } };
          }
          if (input.name === "workspace_status" && input.arguments.action === "performance") {
            return jsonToolResult({
              tasks: 3,
              samples: 8,
              context_ms: { p50_ms: 100, p95_ms: 200 },
              verification_ms: { p95_ms: 20 },
              workflow_efficiency: { failure_rate: 0 }
            });
          }
          if (input.name === "workspace_edit" && input.arguments.action === "apply_patch") {
            return jsonToolResult({
              ok: true,
              rollback_available: true,
              verification: { requested: true, ok: true, duration_ms: 1 }
            });
          }
          if (input.name === "workspace_verify" && input.arguments.action === "quality_gate") {
            assert.deepEqual(input.arguments.arguments.include, ["lint", "typecheck", "test", "build"]);
            return jsonToolResult({ ok: false, failed: 1, ran: 3 });
          }
          if (input.name === "workspace_edit" && input.arguments.action === "undo") {
            return jsonToolResult({ ok: true, tool: "apply_patch" });
          }
          throw new Error("unexpected dependency tool " + input.name + ":" + input.arguments?.action);
        },
        async close() {}
      })
    });

    assert.equal(result.status, "reverted_not_improved");
    assert.equal(result.reverted, true);
    assert.equal(result.evaluation.evaluation_kind, "dependency");
    assert.equal(result.evaluation.observed.reason, "patch_dependency_full_gate_failed");
    assert.ok(calls.some((call) => call.name === "workspace_verify" && call.arguments.action === "quality_gate"));
    assert.ok(calls.some((call) => call.name === "workspace_edit" && call.arguments.action === "undo"));
    assert.equal(
      calls.some((call) => call.name === "workspace_edit" && call.arguments.action === "decision"),
      false,
      "failed full gate must not become accepted improvement memory"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sensorResult(input, root, candidates) {
  if (input.name === "workspace_context") {
    return {
      structuredContent: {
        contextId: "maintenance-context",
        root,
        coverage: {
          codegraph: { status: "ok", query_ms: 35 }
        },
        ranking: { provider: "jev", status: "applied" }
      }
    };
  }
  if (input.name === "workspace_status" && input.arguments.action === "performance") {
    return jsonToolResult({
      tasks: 4,
      samples: 20,
      context_ms: { p50_ms: 100, p95_ms: 220 },
      cache_efficiency: { hit_ratio: 0.5 },
      jev: { latency_ms: { p50_ms: 60, p95_ms: 120 } },
      codegraph: { query_ms: { p50_ms: 20, p95_ms: 35 } }
    });
  }
  if (input.name === "workspace_verify" && input.arguments.action === "semgrep_scan") {
    return jsonToolResult({
      available: true,
      ok: true,
      summary: { error: 0, warning: 1, info: 2, findings: 3 }
    });
  }
  if (input.name === "workspace_verify" && input.arguments.action === "mutation_test") {
    return jsonToolResult({
      available: true,
      ok: true,
      telemetry: { mutation_score: 88, survived: 2 }
    });
  }
  if (input.name === "workspace_status" && input.arguments.action === "dependency_feed") {
    return jsonToolResult({
      available: true,
      ok: true,
      updates: 1,
      auto_apply: false,
      auto_merge: false
    });
  }
  if (input.name === "workspace_search" && input.arguments.action === "ast_search") {
    return jsonToolResult({ available: true, ok: true, matches: [] });
  }
  if (input.name === "workspace_status" && input.arguments.action === "improvement_candidates") {
    return jsonToolResult({ candidates });
  }
  throw new Error("unexpected sweep tool " + input.name + ":" + input.arguments?.action);
}

function safeCandidate({
  root,
  category = "PERFORMANCE",
  safeClass,
  evidence = {},
  execution = {}
}) {
  return rawCandidate({
    category,
    component: category === "DEPENDENCY" ? "dependency:demo" : "workspace_context",
    affected_paths: ["target.txt"],
    evidence: {
      ...evidence,
      execution: {
        kind: "workspace_edit.apply_patch",
        safe_class: safeClass,
        risk: "low",
        architectural_redesign: false,
        operations: [{
          op: "update",
          path: "target.txt",
          edits: [{ old_text: "before", new_text: "after" }]
        }],
        ...execution
      }
    }
  });
}

function unsafeCandidate(root) {
  return rawCandidate({
    component: "architecture-redesign",
    affected_paths: ["target.txt"],
    evidence: {
      execution: {
        kind: "workspace_edit.apply_patch",
        safe_class: "deterministic_codemod",
        risk: "low",
        architectural_redesign: true,
        operations: [{
          op: "update",
          path: path.join(root, "target.txt"),
          edits: [{ old_text: "before", new_text: "after" }]
        }]
      }
    }
  });
}

function rawCandidate({
  category = "PERFORMANCE",
  component = "workspace_context",
  affected_paths = [],
  evidence = {}
} = {}) {
  return {
    source: ["test"],
    category,
    component,
    affected_paths,
    evidence: {
      fingerprint: category + ":" + component + ":" + JSON.stringify(evidence),
      ...evidence
    },
    confidence: 1,
    impact: 0.7,
    frequency: 0.5,
    estimated_cost: 0.2,
    regression_probability: 1,
    estimated_benefit: "test candidate"
  };
}

function jsonToolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }]
  };
}
