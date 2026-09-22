export function collectImprovementMetrics(report = {}) {
  return {
    workspace_context: metric(report.context_ms),
    jev: metric(report.jev?.latency_ms),
    codegraph_index: metric(report.codegraph?.index_ms),
    codegraph_query: metric(report.codegraph?.query_ms),
    search_calls_per_task: number(report.search_efficiency?.calls_per_task),
    read_calls_per_task: number(report.workflow_efficiency?.read_calls_per_task),
    roundtrips_per_task: number(report.workflow_efficiency?.roundtrips_per_task),
    bytes_to_model_per_task: number(report.workflow_efficiency?.bytes_to_model_per_task),
    verification: metric(report.verification_ms),
    cache_hit_ratio: nullableRatio(report.cache_efficiency?.hit_ratio),
    cache_checks: integer(report.cache_efficiency?.checks),
    test_duration: metric(report.test_duration_ms),
    failure_rate: ratio(report.workflow_efficiency?.failure_rate),
    tasks: integer(report.tasks),
    samples: integer(report.samples)
  };
}

export function detectPerformanceCandidates({ metrics = {}, report = {}, root = null } = {}) {
  if (!metrics.tasks) return [];
  const candidates = [];
  const baseline = metrics;
  const add = (candidate) => candidates.push({
    source: ["performance_follow"],
    affected_paths: [],
    baseline,
    regression_probability: 1,
    ...candidate
  });

  if (metrics.workspace_context.p95_ms >= 750 && metrics.workspace_context.calls >= 3) {
    add({
      category: "PERFORMANCE",
      component: "workspace_context",
      evidence: {
        fingerprint: "workspace_context:p95",
        calls: metrics.workspace_context.calls,
        p50_ms: metrics.workspace_context.p50_ms,
        p95_ms: metrics.workspace_context.p95_ms,
        root,
        attribution: (report.trace_attribution?.workspace_context?.top_contributors || [])
          .slice(0, 5)
          .map((entry) => ({
            component: String(entry?.component || "unknown").slice(0, 120),
            calls: integer(entry?.calls),
            p95_ms: number(entry?.p95_ms),
            total_ms: number(entry?.total_ms),
            share_of_parent_p95: nullableRatio(entry?.share_of_parent_p95)
          }))
      },
      impact: scaled(metrics.workspace_context.p95_ms, 750, 3_000),
      frequency: frequency(metrics.workspace_context.calls, metrics.tasks, 2),
      confidence: confidence(metrics.workspace_context.calls),
      estimated_cost: 0.45,
      estimated_benefit: `Reduce workspace_context p95 below ${Math.round(metrics.workspace_context.p95_ms)}ms.`
    });
  }

  if (metrics.jev.p95_ms >= 350 && metrics.jev.calls >= 3) {
    add({
      category: "PERFORMANCE",
      component: "jev",
      evidence: {
        fingerprint: "jev:p95",
        calls: metrics.jev.calls,
        p50_ms: metrics.jev.p50_ms,
        p95_ms: metrics.jev.p95_ms
      },
      impact: scaled(metrics.jev.p95_ms, 350, 2_000),
      frequency: frequency(metrics.jev.calls, metrics.tasks, 2),
      confidence: confidence(metrics.jev.calls),
      estimated_cost: 0.4,
      estimated_benefit: "Reduce repeated Jev ranking/context-selection latency."
    });
  }

  if (metrics.codegraph_index.p95_ms >= 500 && metrics.codegraph_index.calls >= 3) {
    add({
      category: "PERFORMANCE",
      component: "codegraph:index",
      evidence: {
        fingerprint: "codegraph:index:p95",
        calls: metrics.codegraph_index.calls,
        p50_ms: metrics.codegraph_index.p50_ms,
        p95_ms: metrics.codegraph_index.p95_ms
      },
      impact: scaled(metrics.codegraph_index.p95_ms, 500, 2_500),
      frequency: frequency(metrics.codegraph_index.calls, metrics.tasks, 1),
      confidence: confidence(metrics.codegraph_index.calls),
      estimated_cost: 0.5,
      estimated_benefit: "Reduce CodeGraph index synchronization cost."
    });
  }

  if (metrics.codegraph_query.p95_ms >= 120 && metrics.codegraph_query.calls >= 3) {
    add({
      category: "PERFORMANCE",
      component: "codegraph:query",
      evidence: {
        fingerprint: "codegraph:query:p95",
        calls: metrics.codegraph_query.calls,
        p50_ms: metrics.codegraph_query.p50_ms,
        p95_ms: metrics.codegraph_query.p95_ms
      },
      impact: scaled(metrics.codegraph_query.p95_ms, 120, 1_000),
      frequency: frequency(metrics.codegraph_query.calls, metrics.tasks, 2),
      confidence: confidence(metrics.codegraph_query.calls),
      estimated_cost: 0.45,
      estimated_benefit: "Reduce CodeGraph query latency on normal context retrieval."
    });
  }

  if (metrics.search_calls_per_task >= 4) {
    add({
      category: "AGENT_STRATEGY",
      component: "workspace_search",
      evidence: {
        fingerprint: "workspace_search:calls_per_task",
        calls_per_task: metrics.search_calls_per_task,
        tasks: metrics.tasks
      },
      impact: scaled(metrics.search_calls_per_task, 4, 10),
      frequency: Math.min(1, metrics.search_calls_per_task / 8),
      confidence: confidence(metrics.tasks),
      estimated_cost: 0.25,
      estimated_benefit: "Reduce repeated search round-trips per coding task."
    });
  }

  if (metrics.read_calls_per_task >= 7) {
    add({
      category: "AGENT_STRATEGY",
      component: "workspace_read",
      evidence: {
        fingerprint: "workspace_read:calls_per_task",
        calls_per_task: metrics.read_calls_per_task,
        tasks: metrics.tasks
      },
      impact: scaled(metrics.read_calls_per_task, 7, 16),
      frequency: Math.min(1, metrics.read_calls_per_task / 12),
      confidence: confidence(metrics.tasks),
      estimated_cost: 0.2,
      estimated_benefit: "Batch and target source reads to reduce model/tool round-trips."
    });
  }

  if (metrics.cache_checks >= 8 && metrics.cache_hit_ratio !== null && metrics.cache_hit_ratio < 0.5) {
    add({
      category: "PERFORMANCE",
      component: "cache",
      evidence: {
        fingerprint: "cache:hit_ratio",
        checks: metrics.cache_checks,
        hit_ratio: metrics.cache_hit_ratio
      },
      impact: Math.min(1, 0.5 - metrics.cache_hit_ratio + 0.25),
      frequency: Math.min(1, metrics.cache_checks / 40),
      confidence: confidence(metrics.cache_checks),
      estimated_cost: 0.35,
      estimated_benefit: "Increase useful cache hits without weakening freshness guarantees."
    });
  }

  if (metrics.failure_rate >= 0.03 && metrics.roundtrips_per_task >= 3) {
    add({
      category: "RELIABILITY",
      component: "tool-runtime",
      evidence: {
        fingerprint: "tool-runtime:failure-rate",
        failure_rate: metrics.failure_rate,
        roundtrips_per_task: metrics.roundtrips_per_task
      },
      impact: Math.min(1, metrics.failure_rate * 4),
      frequency: Math.min(1, metrics.roundtrips_per_task / 20),
      confidence: confidence(report.workflow_efficiency?.tool_calls || metrics.samples),
      estimated_cost: 0.45,
      estimated_benefit: "Reduce recurring model-facing tool failures."
    });
  }

  if (metrics.verification.p95_ms >= 2_000 && metrics.verification.calls >= 3) {
    add({
      category: "PERFORMANCE",
      component: "workspace_verify",
      evidence: {
        fingerprint: "workspace_verify:p95",
        calls: metrics.verification.calls,
        p50_ms: metrics.verification.p50_ms,
        p95_ms: metrics.verification.p95_ms
      },
      impact: scaled(metrics.verification.p95_ms, 2_000, 20_000),
      frequency: frequency(metrics.verification.calls, metrics.tasks, 1),
      confidence: confidence(metrics.verification.calls),
      estimated_cost: 0.4,
      estimated_benefit: "Reduce verification latency while preserving correctness gates."
    });
  }

  if (metrics.test_duration.p95_ms >= 10_000 && metrics.test_duration.calls >= 2) {
    add({
      category: "PERFORMANCE",
      component: "tests",
      evidence: {
        fingerprint: "tests:p95",
        calls: metrics.test_duration.calls,
        p50_ms: metrics.test_duration.p50_ms,
        p95_ms: metrics.test_duration.p95_ms
      },
      impact: scaled(metrics.test_duration.p95_ms, 10_000, 120_000),
      frequency: frequency(metrics.test_duration.calls, metrics.tasks, 1),
      confidence: confidence(metrics.test_duration.calls),
      estimated_cost: 0.55,
      estimated_benefit: "Shorten feedback time for frequently executed test commands."
    });
  }

  return candidates;
}

function metric(value = {}) {
  return {
    calls: integer(value?.calls),
    p50_ms: number(value?.p50_ms),
    p95_ms: number(value?.p95_ms),
    avg_ms: number(value?.avg_ms),
    max_ms: number(value?.max_ms),
    failures: integer(value?.failures)
  };
}

function confidence(samples) {
  return Math.min(1, 0.35 + Math.log2(Math.max(1, Number(samples) || 0) + 1) / 5);
}

function frequency(calls, tasks, expectedPerTask) {
  if (!tasks) return 0;
  return Math.min(1, Number(calls || 0) / Math.max(1, Number(tasks) * expectedPerTask));
}

function scaled(value, floor, ceiling) {
  if (value <= floor) return 0;
  return Math.min(1, (value - floor) / Math.max(1, ceiling - floor) + 0.25);
}

function nullableRatio(value) {
  if (value === null || value === undefined) return null;
  return ratio(value);
}

function ratio(value) {
  return Math.max(0, Math.min(1, number(value)));
}

function integer(value) {
  return Math.max(0, Math.round(number(value)));
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}
