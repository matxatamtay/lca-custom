import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { createPerformanceFollow } from "../../server/core/performance-follow.mjs";
import { createImprovementCandidateStore } from "../../server/core/self-improvement/improvement-candidate-store.mjs";
import {
  collectImprovementMetrics,
  detectPerformanceCandidates
} from "../../server/core/self-improvement/improvement-metrics.mjs";
import { rankCandidates } from "../../server/core/self-improvement/candidate-scorer.mjs";
import { normalizeCandidate } from "../../server/core/self-improvement/candidate-schema.mjs";
import { createRenovateDependencyFeed } from "../../server/core/self-improvement/dependency-feed.mjs";
import {
  evaluateImprovement,
  evaluationPlan,
  fullGateRequest,
  mutationRequest,
  semgrepRequest
} from "./improvement-evaluator.mjs";
import {
  renderMaintenanceReport,
  runMaintenanceSweep,
  selectSafeCandidate
} from "./maintenance-command.mjs";

const FILTERS = Object.freeze({
  performance: new Set(["PERFORMANCE", "AGENT_STRATEGY"]),
  tests: new Set(["TEST_QUALITY"]),
  dependencies: new Set(["DEPENDENCY"]),
  security: new Set(["SECURITY"])
});

export function createImproveCommand({
  repoRoot,
  dataDir = path.join(repoRoot, "server", "data"),
  detectWorkspaceRoot,
  output = process.stdout,
  configuredRenovateReportPath = process.env.RENOVATE_FEED_PATH,
  configuredRenovateBinary = process.env.RENOVATE_BIN,
  hasCommand = null,
  createExecutionClient = null
} = {}) {
  if (!repoRoot) throw new Error("Improve command requires repoRoot.");
  if (typeof detectWorkspaceRoot !== "function") throw new Error("Improve command requires detectWorkspaceRoot.");

  async function improveCommand(_rest = [], flags = {}) {
    const root = path.resolve(flags.workspace || await detectWorkspaceRoot());
    if (flags.apply && (flags.maintenance || flags.applySafe)) {
      throw new Error("--apply cannot be combined with --maintenance or --apply-safe");
    }
    if (flags.maintenance || flags.applySafe) {
      const offlineReport = await buildImprovementReport({
        root,
        dataDir,
        flags: { ...flags, apply: false, limit: 50 },
        configuredRenovateReportPath,
        configuredRenovateBinary,
        hasCommand
      });
      const sweep = await maintenanceSweep({
        root,
        offlineCandidates: offlineReport.candidates,
        createExecutionClient,
        flags
      });
      let execution = null;
      let selected = null;
      if (flags.applySafe) {
        selected = selectSafeCandidate(sweep.candidates, root);
        if (selected) {
          execution = await executeImprovementCandidate({
            root,
            candidateId: selected.candidate.id,
            candidate: selected.candidate,
            createExecutionClient,
            flags: { ...flags, maintenance: true, applySafe: true }
          });
        }
      }
      const limit = Math.max(1, Math.min(100, Number(flags.limit) || 10));
      const result = {
        ...sweep,
        mode: flags.applySafe ? "maintenance-apply-safe" : "analysis-only",
        analysis_only: !flags.applySafe,
        mutation_allowed: Boolean(flags.applySafe),
        candidates: sweep.candidates.slice(0, limit),
        apply_safe: flags.applySafe
          ? {
              requested: true,
              selected_candidate_id: selected?.candidate?.id || null,
              eligibility: selected?.eligibility || null,
              status: selected ? execution?.status || "failed" : "none_eligible",
              execution
            }
          : {
              requested: false,
              selected_candidate_id: null,
              status: "analysis_only"
            }
      };
      if (flags.json) {
        output.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        output.write(renderMaintenanceReport(result));
        if (flags.applySafe) {
          output.write(selected
            ? renderImprovementExecution(execution)
            : "No explicitly low-risk deterministic maintenance candidate was eligible. No changes applied.\n");
        }
      }
      return result;
    }

    const report = await buildImprovementReport({
      root,
      dataDir,
      flags,
      configuredRenovateReportPath,
      configuredRenovateBinary,
      hasCommand
    });
    if (flags.apply) {
      const candidate = report.candidates.find((item) => item.id === flags.apply);
      const execution = await executeImprovementCandidate({
        root,
        candidateId: flags.apply,
        candidate,
        createExecutionClient,
        flags
      });
      if (flags.json) {
        output.write(JSON.stringify(execution, null, 2) + "\n");
      } else {
        output.write(renderImprovementExecution(execution));
      }
      return execution;
    }
    if (flags.json) {
      output.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      output.write(renderImprovementReport(report));
    }
    return report;
  }

  return { improveCommand };
}

async function maintenanceSweep({
  root,
  offlineCandidates,
  createExecutionClient,
  flags
} = {}) {
  if (typeof createExecutionClient !== "function") {
    return runMaintenanceSweep({
      root,
      offlineCandidates,
      limit: 50
    });
  }

  let client;
  try {
    client = await createExecutionClient(flags);
    return await runMaintenanceSweep({
      root,
      client,
      offlineCandidates,
      limit: 50
    });
  } catch {
    return runMaintenanceSweep({
      root,
      offlineCandidates,
      limit: 50
    });
  } finally {
    if (client && typeof client.close === "function") {
      await client.close().catch(() => undefined);
    }
  }
}

export async function buildImprovementReport({
  root,
  dataDir,
  flags = {},
  configuredRenovateReportPath = null,
  configuredRenovateBinary = null,
  hasCommand = null
} = {}) {
  const resolvedRoot = path.resolve(root || ".");
  const workspaceDataDir = path.join(dataDir, "workspaces", workspaceIdForRoot(resolvedRoot));
  const candidateStore = createImprovementCandidateStore({
    jsonlPath: path.join(workspaceDataDir, "improvement-candidates.jsonl"),
    statePath: path.join(workspaceDataDir, "improvement-state.json")
  });
  await candidateStore.load();
  const stored = await candidateStore.list({ status: "open", limit: 200 });

  const performanceReports = await loadPerformanceReports(dataDir, resolvedRoot);
  const freshPerformance = performanceReports.flatMap((performance) => {
    const metrics = collectImprovementMetrics(performance);
    return detectPerformanceCandidates({
      metrics,
      report: performance,
      root: resolvedRoot
    }).map(normalizeCandidate);
  });

  const dependencyFeed = createRenovateDependencyFeed({
    configuredReportPath: configuredRenovateReportPath,
    configuredBinary: configuredRenovateBinary,
    hasCommand
  });
  const dependencies = await dependencyFeed.inspect({ root: resolvedRoot });

  let candidates = mergeCandidates([
    ...stored,
    ...freshPerformance,
    ...(dependencies.ok && Array.isArray(dependencies.candidates)
      ? dependencies.candidates.map(normalizeCandidate)
      : [])
  ]);
  candidates = rankCandidates(candidates);
  const filter = selectedFilter(flags);
  if (filter) candidates = candidates.filter((candidate) => filter.has(candidate.category));
  if (flags.latest) {
    candidates.sort((left, right) => (
      Number(right.last_seen || right.first_seen || 0) - Number(left.last_seen || left.first_seen || 0)
      || right.score - left.score
    ));
  }

  const limit = flags.apply
    ? 200
    : Math.max(1, Math.min(100, Number(flags.limit) || 10));
  candidates = candidates.slice(0, limit);

  return {
    kind: "lca_improvement_report",
    version: 1,
    generated_at: new Date().toISOString(),
    root: resolvedRoot,
    mode: "analysis-only",
    analysis_only: true,
    mutation_allowed: false,
    secondary_model: false,
    filters: activeFilterNames(flags),
    performance_sources: performanceReports.length,
    dependency_feed: {
      available: dependencies.available,
      reason: dependencies.reason || null,
      report_path: dependencies.report_path || null,
      binary_available: dependencies.binary?.available === true,
      binary_executed: dependencies.binary?.executed === true,
      auto_apply: false,
      auto_merge: false
    },
    candidates
  };
}

export function renderImprovementReport(report) {
  const lines = [
    "LCA Improvement Report",
    "",
    "workspace: " + report.root,
    "mode: analysis-only",
    report.filters.length ? "filters: " + report.filters.join(", ") : "filters: all",
    ""
  ];

  if (!report.candidates.length) {
    lines.push("No matching improvement candidates.");
  } else {
    report.candidates.forEach((candidate, index) => {
      lines.push((index + 1) + ". " + candidateTitle(candidate));
      lines.push("   id: " + candidate.id);
      lines.push("   impact: " + impactLabel(candidate.impact)
        + "   confidence: " + Math.round(Number(candidate.confidence || 0) * 100) + "%"
        + "   score: " + Number(candidate.score || 0).toFixed(3));
      const detail = candidateDetail(candidate);
      if (detail) lines.push("   " + detail);
      if (candidate.estimated_benefit) lines.push("   benefit: " + candidate.estimated_benefit);
    });
  }

  lines.push(
    "",
    "No changes applied. No dependency updates, installs, commits, pushes, auto-merge, or secondary model calls were performed.",
    ""
  );
  return lines.join("\n");
}


export async function executeImprovementCandidate({
  root,
  candidateId,
  candidate,
  createExecutionClient,
  flags = {}
} = {}) {
  const base = {
    kind: "lca_improvement_execution",
    version: 1,
    candidate_id: String(candidateId || ""),
    root: path.resolve(root || "."),
    mode: "explicit-apply",
    explicit: true,
    secondary_model: false,
    commit_performed: false,
    push_performed: false,
    dependency_update_performed: false
  };

  if (!candidate) {
    return {
      ...base,
      ok: false,
      applied: false,
      status: "refused",
      reason: "candidate_not_found"
    };
  }

  const recipe = validateExecutionRecipe(candidate, base.root);
  if (!recipe.ok) {
    return {
      ...base,
      ok: false,
      applied: false,
      status: "refused",
      reason: recipe.reason,
      candidate: candidateSummary(candidate),
      execution_recipe: recipe.summary || null
    };
  }

  const evaluator = evaluationPlan(candidate);
  if (evaluator.kind === "unsupported") {
    return {
      ...base,
      ok: false,
      applied: false,
      status: "refused",
      reason: evaluator.reason,
      candidate: candidateSummary(candidate),
      execution_recipe: recipe.summary,
      evaluation: {
        candidate_id: candidate.id,
        verdict: "not_improved",
        measurable: false,
        evaluation_kind: "unsupported"
      }
    };
  }

  if (typeof createExecutionClient !== "function") {
    return {
      ...base,
      ok: false,
      applied: false,
      status: "refused",
      reason: "execution_client_unavailable",
      candidate: candidateSummary(candidate),
      execution_recipe: recipe.summary
    };
  }

  let client;
  try {
    client = await createExecutionClient(flags);
    if (!client || typeof client.callTool !== "function") {
      throw new Error("Execution client does not implement callTool().");
    }

    const context = await callToolJson(client, "workspace_context", {
      task: "Apply explicit self-improvement candidate " + candidate.id + ": " + candidate.component,
      path: base.root,
      changed_files: recipe.changed_files,
      intent: "implement",
      max_items: 12,
      max_chars: 16_000
    });

    const before = await callToolJson(client, "workspace_status", {
      action: "performance",
      arguments: {
        path: base.root,
        window_days: 30,
        task_class: "user",
        compact: true
      }
    });
    const beforeSensor = await captureEvaluationSensor(
      client,
      evaluator,
      base.root,
      recipe.changed_files,
      "before"
    );

    const edit = await callToolJson(client, "workspace_edit", {
      action: "apply_patch",
      arguments: {
        operations: recipe.operations,
        verify: "changed"
      }
    });

    const after = await callToolJson(client, "workspace_status", {
      action: "performance",
      arguments: {
        path: base.root,
        window_days: 30,
        task_class: "user",
        compact: true
      }
    });
    const afterSensor = await captureEvaluationSensor(
      client,
      evaluator,
      base.root,
      recipe.changed_files,
      "after"
    );

    const evaluation = evaluateImprovement({
      candidate,
      plan: evaluator,
      beforePerformance: before,
      afterPerformance: after,
      beforeSensor,
      afterSensor,
      verification: edit?.verification || null
    });

    const editSummary = {
      ok: edit?.ok !== false,
      changed_files: recipe.changed_files,
      verification: edit?.verification || null,
      rollback_available: edit?.rollback_available === true
    };

    if (evaluation.verdict !== "improved") {
      let rollback = null;
      try {
        rollback = await callToolJson(client, "workspace_edit", {
          action: "undo",
          arguments: {}
        });
      } catch (error) {
        return {
          ...base,
          ok: false,
          applied: edit?.ok !== false,
          reverted: false,
          status: "rollback_failed",
          reason: "evaluation_rejected_but_rollback_failed",
          error: String(error?.message || error).slice(0, 800),
          candidate: candidateSummary(candidate),
          execution_recipe: recipe.summary,
          context: summarizeContext(context),
          before: benchmarkSummary(before),
          edit: editSummary,
          after: benchmarkSummary(after),
          evaluation
        };
      }
      const reverted = rollback?.ok !== false;
      return {
        ...base,
        ok: false,
        applied: !reverted,
        reverted,
        status: reverted ? "reverted_not_improved" : "rollback_failed",
        reason: reverted ? "evaluation_did_not_accept_patch" : "rollback_failed",
        candidate: candidateSummary(candidate),
        execution_recipe: recipe.summary,
        context: summarizeContext(context),
        before: benchmarkSummary(before),
        edit: editSummary,
        after: benchmarkSummary(after),
        evaluation,
        rollback: {
          ok: reverted,
          tool: rollback?.tool || null
        }
      };
    }

    const improvementMemory = await persistAcceptedImprovementMemory(client, {
      root: base.root,
      candidate,
      recipe: recipe.summary,
      evaluation,
      verification: editSummary.verification
    });

    return {
      ...base,
      ok: true,
      applied: true,
      reverted: false,
      status: "accepted",
      dependency_update_performed: candidate.category === "DEPENDENCY",
      candidate: candidateSummary(candidate),
      execution_recipe: recipe.summary,
      context: summarizeContext(context),
      before: benchmarkSummary(before),
      edit: editSummary,
      after: benchmarkSummary(after),
      evaluation,
      improvement_memory: improvementMemory
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      applied: false,
      status: "failed",
      reason: "execution_failed",
      error: String(error?.message || error).slice(0, 800),
      candidate: candidateSummary(candidate),
      execution_recipe: recipe.summary
    };
  } finally {
    if (client && typeof client.close === "function") {
      await client.close().catch(() => undefined);
    }
  }
}

export function validateExecutionRecipe(candidate, root) {
  const execution = candidate?.evidence?.execution;
  if (!execution || typeof execution !== "object") {
    return { ok: false, reason: "candidate_has_no_deterministic_execution_recipe" };
  }
  if (execution.kind !== "workspace_edit.apply_patch") {
    return {
      ok: false,
      reason: "unsupported_execution_recipe",
      summary: { kind: String(execution.kind || "unknown") }
    };
  }

  const inputOperations = Array.isArray(execution.operations) ? execution.operations : [];
  if (inputOperations.length < 1 || inputOperations.length > 20) {
    return {
      ok: false,
      reason: "execution_recipe_operation_count_out_of_bounds",
      summary: { kind: execution.kind, operations: inputOperations.length }
    };
  }

  const resolvedRoot = path.resolve(root || ".");
  const affected = new Set((candidate.affected_paths || []).map((value) =>
    normalizeRelativePath(resolvedRoot, value)
  ).filter(Boolean));
  const operations = [];
  const changedFiles = [];

  for (const operation of inputOperations) {
    if (!operation || operation.op !== "update") {
      return {
        ok: false,
        reason: "execution_recipe_operation_not_allowlisted",
        summary: { kind: execution.kind, allowed_operations: ["update"] }
      };
    }
    const absolutePath = resolveInsideRoot(resolvedRoot, operation.path);
    if (!absolutePath) {
      return {
        ok: false,
        reason: "execution_recipe_path_outside_workspace",
        summary: { kind: execution.kind }
      };
    }
    const relativePath = normalizeRelativePath(resolvedRoot, absolutePath);
    if (affected.size && !affected.has(relativePath)) {
      return {
        ok: false,
        reason: "execution_recipe_path_not_declared_by_candidate",
        summary: { kind: execution.kind, path: relativePath }
      };
    }

    const edits = Array.isArray(operation.edits) ? operation.edits : [];
    if (edits.length < 1 || edits.length > 50) {
      return {
        ok: false,
        reason: "execution_recipe_edit_count_out_of_bounds",
        summary: { kind: execution.kind, path: relativePath, edits: edits.length }
      };
    }

    const normalizedEdits = [];
    for (const edit of edits) {
      const oldText = typeof edit?.old_text === "string" ? edit.old_text : "";
      const newText = typeof edit?.new_text === "string" ? edit.new_text : null;
      if (!oldText || newText === null || oldText.length > 20_000 || newText.length > 20_000) {
        return {
          ok: false,
          reason: "execution_recipe_edit_invalid",
          summary: { kind: execution.kind, path: relativePath }
        };
      }
      normalizedEdits.push({ old_text: oldText, new_text: newText });
    }

    operations.push({
      op: "update",
      path: absolutePath,
      edits: normalizedEdits
    });
    changedFiles.push(absolutePath);
  }

  return {
    ok: true,
    operations,
    changed_files: [...new Set(changedFiles)],
    summary: {
      kind: execution.kind,
      operations: operations.length,
      changed_files: [...new Set(changedFiles.map((file) => normalizeRelativePath(resolvedRoot, file)))],
      verification: "changed",
      benchmark: "performance_follow_before_after"
    }
  };
}

export function renderImprovementExecution(execution) {
  const lines = [
    "LCA Improvement Execution",
    "",
    "candidate: " + execution.candidate_id,
    "workspace: " + execution.root,
    "status: " + execution.status
  ];
  if (execution.reason) lines.push("reason: " + execution.reason);
  if (execution.error) lines.push("error: " + execution.error);
  if (execution.execution_recipe?.changed_files?.length) {
    lines.push("files: " + execution.execution_recipe.changed_files.join(", "));
  }
  if (execution.edit?.verification) {
    lines.push("verification: " + (execution.edit.verification.ok ? "PASS" : "FAIL"));
  }
  if (execution.evaluation) {
    lines.push("evaluation: " + execution.evaluation.verdict);
  }
  if (execution.reverted) lines.push("reverted: yes");
  if (execution.improvement_memory) {
    lines.push("improvement memory: " + (execution.improvement_memory.persisted ? "stored" : "not stored"));
  }
  lines.push(
    "secondary model: no",
    "commit: no",
    "push: no",
    ""
  );
  return lines.join("\n");
}

async function persistAcceptedImprovementMemory(client, {
  root,
  candidate,
  recipe,
  evaluation,
  verification
} = {}) {
  try {
    const result = await callToolJson(client, "workspace_edit", {
      action: "decision",
      arguments: {
        cwd: root,
        decision: `Accepted self-improvement ${candidate.id} for ${candidate.component}`,
        why: `Measured improvement accepted by Phase 14 evaluator: ${compactJson(evaluation.observed, 2_000)}`,
        files: candidate.affected_paths || [],
        memory_kind: "accepted_improvement",
        memory: {
          candidate_id: candidate.id,
          category: candidate.category,
          component: candidate.component,
          problem: candidate.estimated_benefit
            || `Improve ${candidate.component} based on ${(candidate.source || []).join(", ") || "self-improvement evidence"}.`,
          evidence: compactJson(candidate.evidence, 7_500),
          solution: compactJson({
            execution: candidate.evidence?.execution || null,
            recipe
          }, 7_500),
          before: compactJson(evaluation.before, 7_500),
          after: compactJson(evaluation.after, 7_500),
          regression: Boolean(evaluation.regression),
          verdict: "improved",
          verification: compactJson(verification, 7_500),
          regression_rules: Array.isArray(candidate.evidence?.regression_rules)
            ? candidate.evidence.regression_rules.slice(0, 50)
            : []
        }
      }
    });
    return {
      persisted: result?.memory_persisted === true,
      root: result?.root || root
    };
  } catch (error) {
    return {
      persisted: false,
      error: String(error?.message || error).slice(0, 800)
    };
  }
}

async function captureEvaluationSensor(client, plan, root, changedFiles, phase = "after") {
  if (plan?.kind === "mutation") {
    return callToolJson(client, "workspace_verify", mutationRequest(plan, root));
  }
  if (plan?.kind === "semgrep") {
    return callToolJson(client, "workspace_verify", semgrepRequest(root, changedFiles));
  }
  if (plan?.kind === "dependency") {
    return phase === "after"
      ? callToolJson(client, "workspace_verify", fullGateRequest(root))
      : null;
  }
  return null;
}

async function callToolJson(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result?.isError) {
    throw new Error(firstResultText(result) || name + " failed");
  }
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = firstResultText(result);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text: text.slice(0, 4_000) };
  }
}

function compactJson(value, maxChars = 4_000) {
  try {
    const text = JSON.stringify(value ?? null);
    return text.length <= maxChars ? text : text.slice(0, maxChars);
  } catch {
    return "null";
  }
}

function firstResultText(result) {
  return Array.isArray(result?.content)
    ? result.content.find((item) => item?.type === "text" && typeof item.text === "string")?.text || ""
    : "";
}

function summarizeContext(context) {
  return {
    context_id: context?.contextId || context?.context_id || null,
    root: context?.root || null,
    coverage: context?.coverage || null,
    ranking: context?.ranking || null
  };
}

function benchmarkSummary(report) {
  return {
    tasks: Number(report?.tasks || 0),
    samples: Number(report?.samples || 0),
    context_p50_ms: Number(report?.context_ms?.p50_ms || 0),
    context_p95_ms: Number(report?.context_ms?.p95_ms || 0),
    verification_p95_ms: Number(report?.verification_ms?.p95_ms || 0),
    failure_rate: Number(report?.workflow_efficiency?.failure_rate || 0)
  };
}

function candidateSummary(candidate) {
  return {
    id: candidate.id,
    category: candidate.category,
    component: candidate.component,
    affected_paths: candidate.affected_paths || [],
    score: Number(candidate.score || 0)
  };
}

function resolveInsideRoot(root, value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const absolute = path.resolve(root, value);
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".") return null;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absolute;
}

function normalizeRelativePath(root, value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const absolute = path.resolve(root, value);
  const relative = path.relative(root, absolute).replaceAll("\\", "/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return relative;
}

export function workspaceIdForRoot(root, platform = process.platform) {
  const resolved = path.resolve(root);
  const key = platform === "win32" ? resolved.toLowerCase() : resolved;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

async function loadPerformanceReports(dataDir, root) {
  const workspaceRoot = path.join(dataDir, "workspaces");
  let entries = [];
  try {
    entries = await readdir(workspaceRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const reports = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(workspaceRoot, entry.name, "performance-follow.json");
    const follow = createPerformanceFollow({ filePath });
    try {
      await follow.load();
      const report = follow.report({
        root,
        windowDays: 30,
        taskClass: "user",
        compact: false
      });
      if (Number(report?.tasks || 0) > 0 || Number(report?.samples || 0) > 0) reports.push(report);
    } catch {
      // A stale/corrupt telemetry file should not break an otherwise useful analysis-only report.
    }
  }
  return reports;
}

function mergeCandidates(candidates) {
  const byFingerprint = new Map();
  for (const candidate of candidates) {
    if (!candidate?.fingerprint) continue;
    const current = byFingerprint.get(candidate.fingerprint);
    if (!current) {
      byFingerprint.set(candidate.fingerprint, candidate);
      continue;
    }
    byFingerprint.set(candidate.fingerprint, {
      ...current,
      ...candidate,
      first_seen: current.first_seen || candidate.first_seen,
      last_seen: Math.max(Number(current.last_seen || 0), Number(candidate.last_seen || 0)) || null,
      observations: Math.max(Number(current.observations || 0), Number(candidate.observations || 0)) || 0
    });
  }
  return [...byFingerprint.values()];
}

function selectedFilter(flags) {
  const selected = activeFilterNames(flags).filter((name) => name !== "latest");
  if (!selected.length) return null;
  const categories = new Set();
  for (const name of selected) {
    for (const category of FILTERS[name] || []) categories.add(category);
  }
  return categories;
}

function activeFilterNames(flags) {
  return ["latest", "performance", "tests", "dependencies", "security"]
    .filter((name) => flags[name] === true);
}

function candidateTitle(candidate) {
  if (candidate.category === "DEPENDENCY") {
    const pkg = candidate.evidence?.package || candidate.component;
    const from = candidate.evidence?.from || "?";
    const to = candidate.evidence?.to || "?";
    return pkg + " " + from + " → " + to;
  }
  if (candidate.category === "TEST_QUALITY" && candidate.evidence?.mutant_id) {
    return "Surviving mutation " + candidate.evidence.mutant_id + " in "
      + (candidate.affected_paths?.[0] || candidate.component);
  }
  return String(candidate.component || candidate.category || "improvement").replaceAll("_", " ");
}

function candidateDetail(candidate) {
  const evidence = candidate.evidence || {};
  if (candidate.category === "DEPENDENCY") {
    return "dependency risk: " + String(evidence.risk || "unknown").toUpperCase()
      + (evidence.changelog ? "   changelog: " + evidence.changelog : "");
  }
  if (candidate.category === "TEST_QUALITY") {
    const priority = evidence.priority_signal;
    return "test quality risk: " + impactLabel(candidate.impact)
      + (priority ? "   priority signal: " + priority : "");
  }
  if (candidate.category === "SECURITY") {
    return "security risk: " + impactLabel(candidate.impact);
  }
  if (Number.isFinite(Number(evidence.p95_ms))) {
    return "p95: " + Number(evidence.p95_ms).toFixed(1) + "ms"
      + observationSuffix(candidate);
  }
  if (Number.isFinite(Number(evidence.searches_per_task))) {
    return "observed: " + Number(evidence.searches_per_task).toFixed(2) + " searches/task"
      + observationSuffix(candidate);
  }
  return observationSuffix(candidate).replace(/^\s+/, "");
}

function observationSuffix(candidate) {
  const observations = Number(candidate.observations || 0);
  return observations > 0 ? "   observed: " + observations + " time(s)" : "";
}

function impactLabel(value) {
  const number = Number(value || 0);
  return number >= 0.67 ? "HIGH" : number >= 0.34 ? "MEDIUM" : "LOW";
}
