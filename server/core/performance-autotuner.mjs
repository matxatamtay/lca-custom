import { classifyTelemetryTask } from "./performance-telemetry.mjs";

const BASELINE_ITEMS = 10;
const BASELINE_CHARS = 12_000;
const DEFAULT_SAMPLE_LIMIT = 20;
const DEFAULT_HALF_LIFE_MS = 7 * 24 * 60 * 60_000;

export function derivePerformanceTuning(snapshot, root, options = {}) {
  const now = Number(options.now ?? Date.now());
  const traces = tracesForRoot(snapshot, root, options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT, {
    includeNonUser: options.includeNonUser === true
  });
  const metrics = summarize(traces, { now, halfLifeMs: options.halfLifeMs ?? DEFAULT_HALF_LIFE_MS });
  let mode = "baseline";
  let maxItems = BASELINE_ITEMS;
  let maxChars = BASELINE_CHARS;
  const reasons = [];

  if (metrics.samples >= 3 && metrics.avg_reads >= 2.5 && metrics.p50_roundtrips >= 6) {
    mode = "expand_context";
    maxItems = 12;
    maxChars = 15_000;
    reasons.push("recent user tasks require repeated source reads");
  } else if (metrics.samples >= 3 && metrics.p50_bytes_to_model >= 45_000 && metrics.avg_reads < 1.5) {
    mode = "compact_context";
    maxItems = 8;
    maxChars = 9_000;
    reasons.push("recent user tasks return high model payloads without needing many follow-up reads");
  } else {
    reasons.push(metrics.samples < 3
      ? "insufficient clean user-task telemetry; keep conservative defaults"
      : "clean user-task telemetry is within baseline bounds");
  }

  const prewarmPriority = metrics.samples >= 1 && (
    metrics.p95_context_ms >= 500
    || metrics.cold_ratio >= 0.5
    || metrics.cache_hit_ratio !== null && metrics.cache_hit_ratio < 0.3
  ) ? "high" : "normal";
  if (prewarmPriority === "high") reasons.push("user-task p95/cold-cache behavior benefits from prewarming");

  return {
    version: 2,
    mode,
    context: { max_items: maxItems, max_chars: maxChars },
    prewarm_priority: prewarmPriority,
    metrics,
    hygiene: {
      user_only: options.includeNonUser !== true,
      age_weighted: true,
      half_life_days: round((options.halfLifeMs ?? DEFAULT_HALF_LIFE_MS) / (24 * 60 * 60_000))
    },
    reasons: reasons.slice(0, 4)
  };
}

export function applyContextTuning(tuning, requested = {}) {
  const explicitItems = Number.isInteger(requested.maxItems);
  const explicitChars = Number.isInteger(requested.maxChars);
  return {
    maxItems: explicitItems ? requested.maxItems : tuning?.context?.max_items ?? BASELINE_ITEMS,
    maxChars: explicitChars ? requested.maxChars : tuning?.context?.max_chars ?? BASELINE_CHARS,
    explicit_overrides: {
      max_items: explicitItems,
      max_chars: explicitChars
    }
  };
}

export function tracesForRoot(snapshot, root, limit = DEFAULT_SAMPLE_LIMIT, { includeNonUser = false } = {}) {
  const source = [
    ...(Array.isArray(snapshot?.recent) ? snapshot.recent : []),
    ...(Array.isArray(snapshot?.active) ? snapshot.active : [])
  ];
  const seen = new Set();
  const selected = [];
  for (let index = source.length - 1; index >= 0 && selected.length < limit; index -= 1) {
    const trace = source[index];
    if (!trace || trace.root !== root) continue;
    const taskClass = traceClass(trace);
    if (!includeNonUser && taskClass !== "user") continue;
    const id = trace.task_id || `${trace.root}:${trace.started_at}`;
    if (seen.has(id)) continue;
    seen.add(id);
    selected.push({ ...trace, task_class: taskClass });
  }
  return selected;
}

export function summarizePerformanceTraces(traces, options = {}) {
  return summarize(traces, options);
}

function summarize(traces, { now = Date.now(), halfLifeMs = DEFAULT_HALF_LIFE_MS } = {}) {
  if (!traces.length) {
    return {
      samples: 0,
      effective_samples: 0,
      avg_roundtrips: 0,
      avg_reads: 0,
      avg_edits: 0,
      avg_context_ms: 0,
      avg_bytes_to_model: 0,
      p50_roundtrips: 0,
      p95_roundtrips: 0,
      p50_context_ms: 0,
      p95_context_ms: 0,
      p50_bytes_to_model: 0,
      p95_bytes_to_model: 0,
      cold_ratio: 0,
      warm_ratio: 0,
      cache_hit_ratio: null
    };
  }
  const weighted = traces.map((trace) => ({ trace, weight: ageWeight(trace, now, halfLifeMs) }));
  const weightedAverage = (selector) => {
    const numerator = weighted.reduce((sum, entry) => sum + Number(selector(entry.trace) || 0) * entry.weight, 0);
    const denominator = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    return denominator > 0 ? round(numerator / denominator) : 0;
  };
  const cacheSamples = weighted.filter((entry) => Number.isFinite(entry.trace?.cache?.hit_ratio));
  const cacheWeight = cacheSamples.reduce((sum, entry) => sum + entry.weight, 0);
  const temperatureCount = (value) => traces.filter((trace) => trace.context_temperature === value).length;
  const roundtrips = traces.map((trace) => Number(trace.tool_roundtrips || 0));
  const contexts = traces.map((trace) => Number(trace.context_ms || 0));
  const bytes = traces.map((trace) => Number(trace.bytes_to_model || 0));
  return {
    samples: traces.length,
    effective_samples: round(weighted.reduce((sum, entry) => sum + entry.weight, 0)),
    avg_roundtrips: weightedAverage((trace) => trace.tool_roundtrips),
    avg_reads: weightedAverage((trace) => trace.reads),
    avg_edits: weightedAverage((trace) => trace.edits),
    avg_context_ms: weightedAverage((trace) => trace.context_ms),
    avg_bytes_to_model: Math.round(weightedAverage((trace) => trace.bytes_to_model)),
    p50_roundtrips: percentile(roundtrips, 0.5),
    p95_roundtrips: percentile(roundtrips, 0.95),
    p50_context_ms: percentile(contexts, 0.5),
    p95_context_ms: percentile(contexts, 0.95),
    p50_bytes_to_model: Math.round(percentile(bytes, 0.5)),
    p95_bytes_to_model: Math.round(percentile(bytes, 0.95)),
    cold_ratio: round(temperatureCount("cold") / traces.length),
    warm_ratio: round(temperatureCount("warm") / traces.length),
    cache_hit_ratio: cacheWeight > 0
      ? round(cacheSamples.reduce((sum, entry) => sum + Number(entry.trace.cache.hit_ratio) * entry.weight, 0) / cacheWeight)
      : null
  };
}

function traceClass(trace) {
  if (trace?.task_class) return trace.task_class;
  if (trace?.task) {
    const classified = classifyTelemetryTask(trace.task);
    return classified === "unknown" ? "user" : classified;
  }
  return "user";
}

function ageWeight(trace, now, halfLifeMs) {
  const timestamp = Number(trace?.last_at ?? trace?.started_at ?? now);
  if (!Number.isFinite(timestamp) || halfLifeMs <= 0) return 1;
  const age = Math.max(0, now - timestamp);
  return Math.max(0.05, Math.pow(0.5, age / halfLifeMs));
}

function percentile(values, ratio) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  if (sorted.length === 1) return round(sorted[0]);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const value = lower === upper
    ? sorted[lower]
    : sorted[lower] * (1 - (position - lower)) + sorted[upper] * (position - lower);
  return round(value);
}

function round(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}
