import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeWaterfall } from "./runtime-waterfall.mjs";

test("builds parent-child waterfall from durable runtime events", () => {
  const events = [
    evt(1, "tool/started", "corr", "outer", "s1", null, "2026-09-21T00:00:00.000Z"),
    evt(2, "tool/started", "corr", "filesystem", "s2", "s1", "2026-09-21T00:00:00.010Z"),
    evt(3, "tool/completed", "corr", "filesystem", "s2", "s1", "2026-09-21T00:00:00.030Z", 20),
    evt(4, "tool/completed", "corr", "outer", "s1", null, "2026-09-21T00:00:00.050Z", 50)
  ];
  const result = buildRuntimeWaterfall(events, { otelEnabled: false });
  assert.equal(result.kind, "runtime_trace_waterfall");
  assert.equal(result.authoritative_history, "performance_follow");
  assert.equal(result.otel_export_enabled, false);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].spans.length, 2);
  const child = result.groups[0].spans.find((span) => span.span_id === "s2");
  assert.equal(child.parent_span_id, "s1");
  assert.equal(child.depth, 1);
  assert.equal(result.groups[0].duration_ms, 50);
});

test("bounds traces and supports exact correlation filtering", () => {
  const events = [
    evt(1, "tool/completed", "a", "one", "a1", null, "2026-09-21T00:00:00.010Z", 1),
    evt(2, "tool/completed", "b", "two", "b1", null, "2026-09-21T00:00:00.020Z", 1)
  ];
  const result = buildRuntimeWaterfall(events, { correlationId: "a", traceLimit: 1, spanLimit: 1 });
  assert.equal(result.correlations, 1);
  assert.equal(result.groups[0].correlation_id, "a");
  assert.equal(result.groups[0].spans.length, 1);
});

function evt(seq, type, correlationId, name, spanId, parentSpanId, timestamp, durationMs = 0) {
  return {
    seq,
    id: "e" + seq,
    timestamp,
    type,
    correlationId,
    ...(parentSpanId ? { parentId: parentSpanId } : {}),
    data: {
      name,
      surface: name === "outer" ? "facade" : "runtime",
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      success: type !== "tool/failed",
      durationMs
    }
  };
}
