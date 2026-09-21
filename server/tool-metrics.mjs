// Local Coding Agent — privacy-safe tool latency/payload profiler
// SPDX-License-Identifier: AGPL-3.0-or-later

const DEFAULT_RECENT_LIMIT = 500;

export class ToolMetrics {
  constructor(options = {}) {
    this.recentLimit = positiveInt(options.recentLimit, DEFAULT_RECENT_LIMIT);
    this.recent = [];
    this.sequence = 0;
    this.startedAt = new Date().toISOString();
  }

  record(input = {}) {
    const entry = {
      seq: ++this.sequence,
      ts: input.ts || new Date().toISOString(),
      tool: cleanString(input.tool) || "unknown",
      surface: cleanString(input.surface) || "unknown",
      ok: input.ok === true,
      duration_ms: nonNegative(input.durationMs),
      input_chars: nonNegativeInt(input.inChars),
      output_chars: nonNegativeInt(input.outChars)
    };
    this.recent.push(entry);
    if (this.recent.length > this.recentLimit) this.recent.splice(0, this.recent.length - this.recentLimit);
    return entry;
  }

  trace(input = {}) {
    const limit = Math.min(this.recentLimit, positiveInt(input.limit, 100));
    const filtered = this.filter(input);
    return {
      started_at: this.startedAt,
      retained: this.recent.length,
      count: Math.min(limit, filtered.length),
      entries: filtered.slice(-limit).reverse()
    };
  }

  profile(input = {}) {
    const filtered = this.filter(input);
    const groups = new Map();
    for (const entry of filtered) {
      const key = `${entry.surface}\u0000${entry.tool}`;
      if (!groups.has(key)) groups.set(key, { surface: entry.surface, tool: entry.tool, calls: [] });
      groups.get(key).calls.push(entry);
    }
    const tools = [...groups.values()].map(summarizeGroup)
      .sort((left, right) => right.total_duration_ms - left.total_duration_ms || right.calls - left.calls);
    const totals = summarizeGroup({ surface: "all", tool: "all", calls: filtered });
    return {
      started_at: this.startedAt,
      retained: this.recent.length,
      window_calls: filtered.length,
      totals,
      tools,
      recommendations: buildRecommendations(tools)
    };
  }

  reset() {
    this.recent = [];
    this.startedAt = new Date().toISOString();
    return { ok: true, started_at: this.startedAt };
  }

  filter(input) {
    const tool = cleanString(input.tool);
    const surface = cleanString(input.surface);
    const ok = typeof input.ok === "boolean" ? input.ok : null;
    return this.recent.filter((entry) => {
      if (tool && entry.tool !== tool) return false;
      if (surface && entry.surface !== surface) return false;
      if (ok !== null && entry.ok !== ok) return false;
      return true;
    });
  }
}

export function measureJsonChars(value) {
  try {
    const text = JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return String(item);
      if (Buffer.isBuffer(item)) return { type: "Buffer", length: item.length };
      return item;
    });
    return text?.length || 0;
  } catch {
    return 0;
  }
}

function summarizeGroup(group) {
  const calls = group.calls || [];
  const durations = calls.map((entry) => entry.duration_ms).sort((a, b) => a - b);
  const inputChars = calls.reduce((sum, entry) => sum + entry.input_chars, 0);
  const outputChars = calls.reduce((sum, entry) => sum + entry.output_chars, 0);
  const failed = calls.reduce((sum, entry) => sum + (entry.ok ? 0 : 1), 0);
  const totalDuration = durations.reduce((sum, value) => sum + value, 0);
  return {
    surface: group.surface,
    tool: group.tool,
    calls: calls.length,
    failed,
    failure_rate: calls.length ? round(failed / calls.length) : 0,
    total_duration_ms: round(totalDuration),
    avg_duration_ms: calls.length ? round(totalDuration / calls.length) : 0,
    p50_duration_ms: percentile(durations, 0.5),
    p95_duration_ms: percentile(durations, 0.95),
    max_duration_ms: durations.at(-1) || 0,
    total_input_chars: inputChars,
    avg_input_chars: calls.length ? Math.round(inputChars / calls.length) : 0,
    total_output_chars: outputChars,
    avg_output_chars: calls.length ? Math.round(outputChars / calls.length) : 0
  };
}

function buildRecommendations(tools) {
  const recommendations = [];
  for (const item of tools) {
    if (item.calls >= 3 && item.failure_rate >= 0.2) {
      recommendations.push({ priority: "high", tool: item.tool, reason: `failure_rate=${Math.round(item.failure_rate * 100)}%`, action: "Inspect the first recurring failure and tighten validation or readiness checks." });
    }
    if (item.calls >= 3 && item.p95_duration_ms >= 2000) {
      recommendations.push({ priority: "medium", tool: item.tool, reason: `p95=${item.p95_duration_ms}ms`, action: "Consider batching, caching, parallel providers, or an event-driven wait path." });
    }
    if (item.calls >= 2 && item.avg_output_chars >= 50_000) {
      recommendations.push({ priority: "medium", tool: item.tool, reason: `avg_output_chars=${item.avg_output_chars}`, action: "Tighten result budgets, ranking, or compact summaries to reduce model context cost." });
    }
  }
  return recommendations.slice(0, 20);
}

function percentile(sorted, quantile) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return round(sorted[index]);
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? round(number) : 0;
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function round(value) {
  return Math.round(Number(value) * 10) / 10;
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
