const PERFORMANCE_METRICS = Object.freeze({
  workspace_context: { path: "context_ms.p95_ms", direction: "lower" },
  "workspace_verify": { path: "verification_ms.p95_ms", direction: "lower" },
  jev: { path: "jev.latency_ms.p95_ms", direction: "lower" },
  "codegraph:index": { path: "codegraph.index_ms.p95_ms", direction: "lower" },
  "codegraph:query": { path: "codegraph.query_ms.p95_ms", direction: "lower" },
  workspace_search: { path: "search_efficiency.calls_per_task", direction: "lower" },
  workspace_read: { path: "workflow_efficiency.read_calls_per_task", direction: "lower" },
  workflow: { path: "workflow_efficiency.roundtrips_per_task", direction: "lower" },
  payload: { path: "workflow_efficiency.bytes_to_model_per_task", direction: "lower" },
  cache: { path: "cache_efficiency.hit_ratio", direction: "higher" },
  reliability: { path: "workflow_efficiency.failure_rate", direction: "lower" }
});

const ALLOWED_METRICS = new Set(Object.values(PERFORMANCE_METRICS).map((item) => item.path));

export function evaluationPlan(candidate, {
  noiseThreshold = 0.05
} = {}) {
  const category = String(candidate?.category || "").toUpperCase();
  const explicit = candidate?.evidence?.evaluation;
  const threshold = boundedThreshold(explicit?.noise_threshold ?? noiseThreshold);

  if (category === "TEST_QUALITY") {
    return {
      kind: "mutation",
      threshold,
      mode: ["changed", "module", "full"].includes(explicit?.mode) ? explicit.mode : "changed",
      module: typeof explicit?.module === "string" ? explicit.module : null,
      range: validRange(explicit?.range) ? explicit.range : null
    };
  }

  if (category === "SECURITY") {
    return { kind: "semgrep", threshold };
  }

  if (category === "RELIABILITY") {
    return {
      kind: "performance",
      metric: "workflow_efficiency.failure_rate",
      direction: "lower",
      threshold
    };
  }

  if (
    category === "DEPENDENCY"
    && candidate?.evidence?.execution?.safe_class === "patch_dependency_update"
    && candidate?.evidence?.execution?.full_green_gate === true
  ) {
    return {
      kind: "dependency",
      threshold: 0,
      from: String(candidate?.evidence?.from || candidate?.baseline?.version || "").trim(),
      to: String(candidate?.evidence?.to || "").trim(),
      full_green_gate: true
    };
  }

  if (category === "PERFORMANCE" || category === "AGENT_STRATEGY" || category === "DEPENDENCY") {
    const explicitMetric = typeof explicit?.metric === "string" ? explicit.metric : "";
    if (explicitMetric && ALLOWED_METRICS.has(explicitMetric)) {
      return {
        kind: "performance",
        metric: explicitMetric,
        direction: explicit?.direction === "higher" ? "higher" : "lower",
        threshold
      };
    }
    const inferred = PERFORMANCE_METRICS[String(candidate?.component || "")];
    if (inferred) {
      return {
        kind: "performance",
        metric: inferred.path,
        direction: inferred.direction,
        threshold
      };
    }
  }

  return {
    kind: "unsupported",
    threshold,
    reason: "candidate_has_no_measurable_evaluation_plan"
  };
}

export function evaluateImprovement({
  candidate,
  plan,
  beforePerformance,
  afterPerformance,
  beforeSensor = null,
  afterSensor = null,
  verification = null
} = {}) {
  const correctnessPass = verification?.requested === true && verification?.ok === true;
  const before = evidenceSnapshot(plan, beforePerformance, beforeSensor, null);
  const after = evidenceSnapshot(plan, afterPerformance, afterSensor, correctnessPass ? "pass" : "fail");

  let signal = {
    available: false,
    improved: false,
    regression: false,
    before: null,
    after: null,
    delta: null,
    relative_improvement: null,
    reason: plan?.reason || "evaluation_unavailable"
  };

  if (plan?.kind === "performance") {
    signal = compareMetric(
      numberAt(beforePerformance, plan.metric),
      numberAt(afterPerformance, plan.metric),
      plan.direction,
      plan.threshold
    );
  } else if (plan?.kind === "mutation") {
    signal = compareMetric(
      mutationScore(beforeSensor),
      mutationScore(afterSensor),
      "higher",
      plan.threshold
    );
  } else if (plan?.kind === "semgrep") {
    signal = compareMetric(
      securityRiskScore(beforeSensor),
      securityRiskScore(afterSensor),
      "lower",
      plan.threshold
    );
  } else if (plan?.kind === "dependency") {
    const changed = Boolean(plan.from && plan.to && plan.from !== plan.to);
    const gateAvailable = afterSensor && typeof afterSensor.ok === "boolean";
    const gateOk = afterSensor?.ok === true;
    signal = {
      available: Boolean(changed && gateAvailable),
      improved: Boolean(changed && gateOk),
      regression: gateAvailable && !gateOk,
      before: plan.from || null,
      after: plan.to || null,
      delta: null,
      relative_improvement: null,
      reason: !changed
        ? "dependency_version_change_unavailable"
        : !gateAvailable
          ? "full_green_gate_unavailable"
          : gateOk
            ? "patch_dependency_changed_and_full_gate_passed"
            : "patch_dependency_full_gate_failed"
    };
  }

  const accepted = correctnessPass && signal.available && signal.improved;
  const regression = !correctnessPass || signal.regression;
  return {
    candidate_id: candidate?.id || null,
    before,
    after,
    regression,
    verdict: accepted ? "improved" : "not_improved",
    correctness_pass: correctnessPass,
    measurable: signal.available,
    evaluation_kind: plan?.kind || "unsupported",
    metric: plan?.metric || sensorMetricName(plan),
    direction: plan?.direction || sensorDirection(plan),
    noise_threshold: Number(plan?.threshold || 0),
    observed: signal
  };
}

export function mutationRequest(plan, root) {
  return {
    action: "mutation_test",
    arguments: {
      cwd: root,
      mode: plan?.mode || "changed",
      max_candidates: 100,
      ...(plan?.module ? { module: plan.module } : {}),
      ...(plan?.range ? { range: plan.range } : {})
    }
  };
}

export function semgrepRequest(root, changedFiles = []) {
  return {
    action: "semgrep_scan",
    arguments: {
      cwd: root,
      ...(changedFiles.length ? { paths: changedFiles } : {}),
      max_results: 200
    }
  };
}

export function fullGateRequest(root) {
  return {
    action: "quality_gate",
    arguments: {
      cwd: root,
      include: ["lint", "typecheck", "test", "build"],
      timeout_ms: 600_000,
      stop_on_failure: true,
      dry_run: false
    }
  };
}

function evidenceSnapshot(plan, performance, sensor, tests) {
  const base = {
    p50_ms: performanceP50(performance, plan),
    p95_ms: performanceP95(performance, plan),
    tests,
    mutation_score: mutationScore(sensor)
  };
  if (plan?.kind === "semgrep") {
    base.security = semgrepSummary(sensor);
  }
  if (plan?.kind === "dependency") {
    base.dependency = {
      from: plan.from || null,
      to: plan.to || null,
      full_green_gate_ok: typeof sensor?.ok === "boolean" ? sensor.ok : null
    };
  }
  if (plan?.kind === "performance" || plan?.kind === "mutation" || plan?.kind === "semgrep") {
    base.metric_value = metricValue(plan, performance, sensor);
  }
  return base;
}

function metricValue(plan, performance, sensor) {
  if (plan?.kind === "performance") return numberAt(performance, plan.metric);
  if (plan?.kind === "mutation") return mutationScore(sensor);
  if (plan?.kind === "semgrep") return securityRiskScore(sensor);
  return null;
}

function performanceP50(performance, plan) {
  if (plan?.kind !== "performance") return null;
  if (plan.metric.endsWith(".p95_ms")) {
    return numberAt(performance, plan.metric.replace(/\.p95_ms$/, ".p50_ms"));
  }
  return null;
}

function performanceP95(performance, plan) {
  if (plan?.kind !== "performance") return null;
  return plan.metric.endsWith(".p95_ms") ? numberAt(performance, plan.metric) : null;
}

function compareMetric(before, after, direction, threshold) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return {
      available: false,
      improved: false,
      regression: false,
      before: finiteOrNull(before),
      after: finiteOrNull(after),
      delta: null,
      relative_improvement: null,
      reason: "metric_unavailable"
    };
  }

  const delta = after - before;
  const baseline = Math.max(Math.abs(before), 1e-9);
  const signedImprovement = direction === "higher" ? delta : -delta;
  const relative = signedImprovement / baseline;
  return {
    available: true,
    improved: signedImprovement > 0 && relative >= threshold,
    regression: signedImprovement < 0 && Math.abs(relative) >= threshold,
    before,
    after,
    delta,
    relative_improvement: round(relative),
    reason: signedImprovement > 0 && relative >= threshold
      ? "improvement_exceeds_noise_threshold"
      : "improvement_does_not_exceed_noise_threshold"
  };
}

function mutationScore(sensor) {
  const value = sensor?.telemetry?.mutation_score ?? sensor?.mutation_score;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function semgrepSummary(sensor) {
  const summary = sensor?.summary || {};
  return {
    error: boundedNumber(summary.error),
    warning: boundedNumber(summary.warning),
    info: boundedNumber(summary.info),
    findings: boundedNumber(summary.findings)
  };
}

function securityRiskScore(sensor) {
  if (!sensor || sensor.available === false) return null;
  const summary = semgrepSummary(sensor);
  return summary.error * 100 + summary.warning * 10 + summary.info;
}

function sensorMetricName(plan) {
  if (plan?.kind === "mutation") return "mutation_score";
  if (plan?.kind === "semgrep") return "semgrep_severity_score";
  if (plan?.kind === "dependency") return "dependency_version_plus_full_green_gate";
  return null;
}

function sensorDirection(plan) {
  if (plan?.kind === "mutation") return "higher";
  if (plan?.kind === "semgrep") return "lower";
  if (plan?.kind === "dependency") return "pass";
  return null;
}

function numberAt(value, dottedPath) {
  if (!dottedPath) return null;
  let current = value;
  for (const part of dottedPath.split(".")) {
    if (!current || typeof current !== "object") return null;
    current = current[part];
  }
  const number = Number(current);
  return Number.isFinite(number) ? number : null;
}

function validRange(value) {
  return value
    && Number.isInteger(value.start_line)
    && Number.isInteger(value.end_line)
    && value.start_line >= 1
    && value.end_line >= value.start_line;
}

function boundedThreshold(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.05;
  return Math.max(0.001, Math.min(0.5, number));
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function boundedNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}
