export function buildRuntimeWaterfall(events = [], {
  correlationId = null,
  traceLimit = 5,
  spanLimit = 200,
  otelEnabled = false
} = {}) {
  const source = Array.isArray(events) ? events : [];
  const byCorrelation = new Map();

  for (const event of source) {
    const id = typeof event?.correlationId === "string" ? event.correlationId : null;
    if (!id || (correlationId && id !== correlationId)) continue;
    const list = byCorrelation.get(id) || [];
    list.push(event);
    byCorrelation.set(id, list);
  }

  const groups = [...byCorrelation.entries()]
    .map(([id, groupEvents]) => buildGroup(id, groupEvents, spanLimit))
    .filter((group) => group.spans.length > 0 || group.events.length > 0)
    .sort((left, right) => right.last_seq - left.last_seq)
    .slice(0, Math.max(1, Math.min(20, Number(traceLimit) || 5)));

  return {
    kind: "runtime_trace_waterfall",
    source: "RuntimeEventStore",
    authoritative_history: "performance_follow",
    otel_export_enabled: Boolean(otelEnabled),
    correlations: groups.length,
    groups
  };
}

function buildGroup(correlationId, events, spanLimit) {
  const ordered = [...events].sort((left, right) => Number(left?.seq || 0) - Number(right?.seq || 0));
  const startedBySpan = new Map();
  const completed = [];

  for (const event of ordered) {
    const data = asRecord(event?.data);
    const spanId = stringValue(data.spanId);
    if (!spanId) continue;
    if (event.type === "tool/started") {
      startedBySpan.set(spanId, event);
      continue;
    }
    if (event.type === "tool/completed" || event.type === "tool/failed") {
      completed.push(event);
    }
  }

  const bounded = completed.slice(-Math.max(1, Math.min(2000, Number(spanLimit) || 200)));
  const spans = bounded.map((event) => {
    const data = asRecord(event.data);
    const spanId = stringValue(data.spanId);
    const started = startedBySpan.get(spanId);
    const parentSpanId = stringValue(data.parentSpanId) || stringValue(event.parentId);
    const durationMs = finiteNumber(data.durationMs);
    return {
      span_id: spanId,
      parent_span_id: parentSpanId,
      name: stringValue(data.name) || "unknown",
      surface: stringValue(data.surface) || "unknown",
      status: event.type === "tool/failed" || data.success === false ? "error" : "ok",
      started_at: started?.timestamp || deriveStartedAt(event.timestamp, durationMs),
      ended_at: event.timestamp,
      duration_ms: durationMs,
      seq: Number(event.seq || 0)
    };
  });

  const spanMap = new Map(spans.map((span) => [span.span_id, span]));
  const withDepth = spans
    .map((span) => ({ ...span, depth: spanDepth(span, spanMap) }))
    .sort((left, right) => (
      Date.parse(left.started_at || "") - Date.parse(right.started_at || "")
      || left.seq - right.seq
    ));

  const compactEvents = ordered.slice(-Math.max(1, Math.min(2000, Number(spanLimit) * 2 || 400))).map((event) => {
    const data = asRecord(event.data);
    return {
      seq: Number(event.seq || 0),
      type: String(event.type || ""),
      timestamp: String(event.timestamp || ""),
      name: stringValue(data.name),
      span_id: stringValue(data.spanId),
      parent_span_id: stringValue(data.parentSpanId) || stringValue(event.parentId),
      duration_ms: finiteNumber(data.durationMs),
      success: typeof data.success === "boolean" ? data.success : null
    };
  });

  const startTimes = withDepth.map((span) => Date.parse(span.started_at || "")).filter(Number.isFinite);
  const endTimes = withDepth.map((span) => Date.parse(span.ended_at || "")).filter(Number.isFinite);
  const startedAt = startTimes.length ? new Date(Math.min(...startTimes)).toISOString() : null;
  const endedAt = endTimes.length ? new Date(Math.max(...endTimes)).toISOString() : null;

  return {
    correlation_id: correlationId,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: startedAt && endedAt ? round(Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))) : 0,
    spans: withDepth,
    events: compactEvents,
    last_seq: ordered.at(-1)?.seq ?? 0
  };
}

function spanDepth(span, spanMap) {
  let depth = 0;
  let parent = span.parent_span_id ? spanMap.get(span.parent_span_id) : null;
  const visited = new Set([span.span_id]);
  while (parent && !visited.has(parent.span_id) && depth < 32) {
    visited.add(parent.span_id);
    depth += 1;
    parent = parent.parent_span_id ? spanMap.get(parent.parent_span_id) : null;
  }
  return depth;
}

function deriveStartedAt(endedAt, durationMs) {
  const ended = Date.parse(String(endedAt || ""));
  if (!Number.isFinite(ended)) return null;
  return new Date(Math.max(0, ended - durationMs)).toISOString();
}

function asRecord(value) {
  return value && typeof value === "object" ? value : {};
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? round(Math.max(0, number)) : 0;
}

function round(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}
