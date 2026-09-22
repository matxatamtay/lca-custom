import path from "node:path";

import { normalizeCandidate } from "../../server/core/self-improvement/candidate-schema.mjs";
import { rankCandidates } from "../../server/core/self-improvement/candidate-scorer.mjs";

const SAFE_CLASSES = new Set([
  "deterministic_codemod",
  "format_config_cleanup",
  "known_regression_fix",
  "patch_dependency_update"
]);

const AST_CHECKS = Object.freeze([
  { id: "no-codex-delegation-manager", pattern: "CodexDelegationManager", component: "direct-only-runtime" },
  { id: "no-agent-runner-registry", pattern: "AgentRunnerRegistry", component: "direct-only-runtime" }
]);

export async function runMaintenanceSweep({
  root,
  client,
  offlineCandidates = [],
  limit = 10
} = {}) {
  const resolvedRoot = path.resolve(root || ".");
  if (!client || typeof client.callTool !== "function") {
    return {
      kind: "lca_maintenance_report",
      version: 1,
      root: resolvedRoot,
      mode: "analysis-only",
      analysis_only: true,
      mutation_allowed: false,
      secondary_model: false,
      commit_performed: false,
      push_performed: false,
      sensors: unavailableSensors("execution_client_unavailable"),
      candidates: rankCandidates(offlineCandidates).slice(0, boundedLimit(limit))
    };
  }

  const context = await safeCall(client, "workspace_context", {
    task: "Run an analysis-only LCA self-improvement maintenance sweep.",
    path: resolvedRoot,
    intent: "review",
    max_items: 10,
    max_chars: 12_000
  });

  const [performance, semgrep, mutation, dependencies, astChecks] = await Promise.all([
    safeCall(client, "workspace_status", {
      action: "performance",
      arguments: {
        path: resolvedRoot,
        window_days: 30,
        task_class: "user",
        compact: false
      }
    }),
    safeCall(client, "workspace_verify", {
      action: "semgrep_scan",
      arguments: {
        cwd: resolvedRoot,
        max_results: 200
      }
    }),
    safeCall(client, "workspace_verify", {
      action: "mutation_test",
      arguments: {
        cwd: resolvedRoot,
        mode: "changed",
        max_candidates: 100
      }
    }),
    safeCall(client, "workspace_status", {
      action: "dependency_feed",
      arguments: {
        path: resolvedRoot,
        ingest: true
      }
    }),
    collectAstChecks(client, resolvedRoot)
  ]);

  const improvements = await safeCall(client, "workspace_status", {
    action: "improvement_candidates",
    arguments: {
      path: resolvedRoot,
      window_days: 30,
      task_class: "user",
      limit: 50,
      refresh: true
    }
  });

  const serverCandidates = Array.isArray(improvements.value?.candidates)
    ? improvements.value.candidates
    : [];
  const astCandidates = astFindingsToCandidates(astChecks);
  const candidates = rankCandidates(mergeCandidates([
    ...offlineCandidates,
    ...serverCandidates,
    ...astCandidates
  ])).slice(0, boundedLimit(limit));

  return {
    kind: "lca_maintenance_report",
    version: 1,
    generated_at: new Date().toISOString(),
    root: resolvedRoot,
    mode: "analysis-only",
    analysis_only: true,
    mutation_allowed: false,
    secondary_model: false,
    commit_performed: false,
    push_performed: false,
    sensors: {
      performance_history: sensorSummary(performance, {
        tasks: performance.value?.tasks ?? 0,
        samples: performance.value?.samples ?? 0,
        context_p95_ms: performance.value?.context_ms?.p95_ms ?? 0
      }),
      semgrep: sensorSummary(semgrep, semgrep.value?.summary || null),
      ast_grep: {
        ok: astChecks.every((check) => check.ok),
        available: astChecks.some((check) => check.available),
        checks: astChecks.map((check) => ({
          id: check.id,
          available: check.available,
          ok: check.ok,
          findings: check.matches.length
        })),
        findings: astChecks.reduce((sum, check) => sum + check.matches.length, 0)
      },
      mutation: sensorSummary(mutation, {
        available: mutation.value?.available !== false,
        mutation_score: mutation.value?.telemetry?.mutation_score ?? null,
        survived: mutation.value?.telemetry?.survived ?? null
      }),
      dependencies: sensorSummary(dependencies, {
        available: dependencies.value?.available === true,
        updates: dependencies.value?.updates ?? 0,
        auto_apply: false,
        auto_merge: false
      }),
      dependency_security_state: {
        dependency_feed_available: dependencies.value?.available === true,
        semgrep_error: Number(semgrep.value?.summary?.error || 0),
        semgrep_warning: Number(semgrep.value?.summary?.warning || 0)
      },
      cache_behavior: performance.value?.cache_efficiency || null,
      jev_behavior: performance.value?.jev || context.value?.ranking || null,
      codegraph_behavior: performance.value?.codegraph || context.value?.coverage?.codegraph || null,
      live_context: {
        ok: context.ok,
        coverage: context.value?.coverage || null,
        ranking: context.value?.ranking || null
      }
    },
    candidates
  };
}

export function safeApplyEligibility(candidate, root) {
  const execution = candidate?.evidence?.execution;
  if (!execution || typeof execution !== "object") {
    return { eligible: false, reason: "missing_deterministic_execution_recipe" };
  }

  const safeClass = String(execution.safe_class || "").trim();
  if (!SAFE_CLASSES.has(safeClass)) {
    return { eligible: false, reason: "safe_class_not_allowlisted", safe_class: safeClass || null };
  }
  if (String(execution.risk || "").toLowerCase() !== "low") {
    return { eligible: false, reason: "candidate_not_explicitly_low_risk", safe_class: safeClass };
  }
  if (execution.architectural_redesign === true) {
    return { eligible: false, reason: "architectural_redesign_forbidden", safe_class: safeClass };
  }

  const bounded = validateBoundedRecipe(candidate, root);
  if (!bounded.ok) {
    return { eligible: false, reason: bounded.reason, safe_class: safeClass };
  }

  if (safeClass === "known_regression_fix") {
    const rules = candidate?.evidence?.regression_rules;
    if ((!Array.isArray(rules) || rules.length === 0) && !execution.regression_rule) {
      return {
        eligible: false,
        reason: "known_regression_fix_requires_rule_reference",
        safe_class: safeClass
      };
    }
  }

  if (safeClass === "patch_dependency_update") {
    const updateType = String(
      candidate?.evidence?.update_type
      || candidate?.evidence?.risk_metadata?.update_type
      || ""
    ).toLowerCase();
    if (candidate?.category !== "DEPENDENCY") {
      return {
        eligible: false,
        reason: "dependency_safe_class_requires_dependency_candidate",
        safe_class: safeClass
      };
    }
    if (String(candidate?.evidence?.risk || "").toLowerCase() !== "low" || updateType !== "patch") {
      return {
        eligible: false,
        reason: "dependency_update_not_patch_level_low_risk",
        safe_class: safeClass
      };
    }
    if (execution.full_green_gate !== true) {
      return {
        eligible: false,
        reason: "patch_dependency_requires_full_green_gate",
        safe_class: safeClass
      };
    }
  }

  return {
    eligible: true,
    reason: "explicit_low_risk_deterministic_candidate",
    safe_class: safeClass,
    requires_full_green_gate: safeClass === "patch_dependency_update"
  };
}

export function selectSafeCandidate(candidates, root) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const eligibility = safeApplyEligibility(candidate, root);
    if (eligibility.eligible) return { candidate, eligibility };
  }
  return null;
}

export function renderMaintenanceReport(report) {
  const lines = [
    "LCA Maintenance Report",
    "",
    "workspace: " + report.root,
    "mode: analysis-only",
    "sensors:",
    "  performance: " + sensorLabel(report.sensors?.performance_history),
    "  semgrep: " + sensorLabel(report.sensors?.semgrep),
    "  ast-grep: " + (report.sensors?.ast_grep?.available ? "available" : "unavailable")
      + " (" + Number(report.sensors?.ast_grep?.findings || 0) + " finding(s))",
    "  mutation: " + sensorLabel(report.sensors?.mutation),
    "  dependencies: " + sensorLabel(report.sensors?.dependencies),
    ""
  ];

  if (!report.candidates?.length) {
    lines.push("No ranked maintenance candidates.");
  } else {
    report.candidates.forEach((candidate, index) => {
      lines.push(
        (index + 1) + ". [" + candidate.category + "] " + candidate.component
        + "  score=" + Number(candidate.score || 0).toFixed(3)
      );
      lines.push("   id: " + candidate.id);
    });
  }

  lines.push("", "No changes applied by the maintenance sweep.", "");
  return lines.join("\n");
}

async function collectAstChecks(client, root) {
  const checks = [];
  for (const check of AST_CHECKS) {
    const languageResults = [];
    for (const lang of ["js", "ts"]) {
      const response = await safeCall(client, "workspace_search", {
        action: "ast_search",
        arguments: {
          pattern: check.pattern,
          lang,
          path: root,
          limit: 50
        }
      });
      languageResults.push(response);
    }
    const available = languageResults.some((result) => result.ok && result.value?.available !== false);
    const matches = languageResults.flatMap((result) => (
      Array.isArray(result.value?.matches) ? result.value.matches : []
    ));
    checks.push({
      ...check,
      ok: languageResults.every((result) => result.ok),
      available,
      matches
    });
  }
  return checks;
}

function astFindingsToCandidates(checks) {
  return checks.flatMap((check) => {
    if (!check.available || !check.matches.length) return [];
    const affectedPaths = [...new Set(check.matches
      .map((match) => typeof match?.path === "string" ? match.path : "")
      .filter(Boolean))]
      .slice(0, 100);
    return [normalizeCandidate({
      source: ["ast-grep", "maintenance"],
      category: "CORRECTNESS",
      component: check.component,
      affected_paths: affectedPaths,
      evidence: {
        fingerprint: "maintenance:ast:" + check.id + ":" + affectedPaths.join("|"),
        check_id: check.id,
        engine: "ast-grep",
        findings: check.matches.length,
        structural_pattern: check.pattern
      },
      confidence: 1,
      impact: 0.9,
      frequency: 0.5,
      estimated_cost: 0.4,
      regression_probability: 1,
      estimated_benefit: "Restore the direct-only LCA architecture invariant detected by ast-grep."
    })];
  });
}

function validateBoundedRecipe(candidate, root) {
  const execution = candidate?.evidence?.execution;
  if (execution?.kind !== "workspace_edit.apply_patch") {
    return { ok: false, reason: "unsupported_execution_recipe" };
  }
  const operations = Array.isArray(execution.operations) ? execution.operations : [];
  if (operations.length < 1 || operations.length > 20) {
    return { ok: false, reason: "execution_recipe_operation_count_out_of_bounds" };
  }

  const resolvedRoot = path.resolve(root || ".");
  for (const operation of operations) {
    if (operation?.op !== "update") {
      return { ok: false, reason: "execution_recipe_operation_not_allowlisted" };
    }
    const target = path.resolve(resolvedRoot, String(operation.path || ""));
    const relative = path.relative(resolvedRoot, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return { ok: false, reason: "execution_recipe_path_outside_workspace" };
    }
    const edits = Array.isArray(operation.edits) ? operation.edits : [];
    if (edits.length < 1 || edits.length > 50) {
      return { ok: false, reason: "execution_recipe_edit_count_out_of_bounds" };
    }
  }
  return { ok: true };
}

async function safeCall(client, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args });
    if (result?.isError) {
      return { ok: false, value: null, error: firstText(result) || name + " failed" };
    }
    return { ok: true, value: parseResult(result), error: null };
  } catch (error) {
    return { ok: false, value: null, error: String(error?.message || error).slice(0, 800) };
  }
}

function parseResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = firstText(result);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text: text.slice(0, 4_000) };
  }
}

function firstText(result) {
  return Array.isArray(result?.content)
    ? result.content.find((item) => item?.type === "text" && typeof item.text === "string")?.text || ""
    : "";
}

function mergeCandidates(candidates) {
  const byFingerprint = new Map();
  for (const raw of candidates) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw.fingerprint ? raw : normalizeCandidate(raw);
    if (!candidate.fingerprint) continue;
    const existing = byFingerprint.get(candidate.fingerprint);
    if (!existing || Number(candidate.score || 0) > Number(existing.score || 0)) {
      byFingerprint.set(candidate.fingerprint, candidate);
    }
  }
  return [...byFingerprint.values()];
}

function sensorSummary(response, detail) {
  return {
    ok: response.ok,
    available: response.ok && response.value?.available !== false,
    ...(response.error ? { error: response.error } : {}),
    detail
  };
}

function unavailableSensors(reason) {
  return {
    performance_history: { ok: false, available: false, error: reason },
    semgrep: { ok: false, available: false, error: reason },
    ast_grep: { ok: false, available: false, findings: 0, checks: [] },
    mutation: { ok: false, available: false, error: reason },
    dependencies: { ok: false, available: false, error: reason },
    dependency_security_state: null,
    cache_behavior: null,
    jev_behavior: null,
    codegraph_behavior: null,
    live_context: { ok: false, coverage: null, ranking: null }
  };
}

function sensorLabel(sensor) {
  return sensor?.ok && sensor?.available ? "available" : "unavailable";
}

function boundedLimit(value) {
  return Math.max(1, Math.min(50, Number(value) || 10));
}
