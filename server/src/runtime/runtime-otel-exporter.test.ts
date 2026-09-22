import test from "node:test";
import assert from "node:assert/strict";

import { RuntimeOtelExporter, traceIdForCorrelation } from "./runtime-otel-exporter.js";

test("trace id derivation is stable and OTLP-compatible", () => {
  const traceId = traceIdForCorrelation("corr-1");
  assert.match(traceId, /^[a-f0-9]{32}$/);
  assert.equal(traceIdForCorrelation("corr-1"), traceId);
});

test("OTLP exporter emits metadata-only spans to v1/traces", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const exporter = new RuntimeOtelExporter({
    endpoint: "http://127.0.0.1:4318",
    fetchImpl: (async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch
  });
  await exporter.observe({
    name: "workspace_read",
    surface: "facade",
    correlationId: "corr-1",
    spanId: "span-child",
    parentSpanId: "span-parent",
    startedAt: "2026-08-18T00:00:00.000Z",
    durationMs: 12.5,
    success: true,
    inChars: 123,
    outChars: 456,
    args: { private_input: "must-not-export" },
    result: { private_output: "must-not-export" }
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "http://127.0.0.1:4318/v1/traces");
  const text = JSON.stringify(requests[0]?.body);
  assert.doesNotMatch(text, /must-not-export/);
  assert.match(text, /workspace_read/);
  assert.match(text, /lca\.input_chars/);
  assert.match(text, /parentSpanId/);
});

test("OTLP exporter makes zero network calls when endpoint is unset", async () => {
  let calls = 0;
  const exporter = new RuntimeOtelExporter({
    fetchImpl: (async () => {
      calls += 1;
      throw new Error("network must stay disabled");
    }) as typeof fetch
  });
  assert.equal(exporter.enabled, false);
  await exporter.observe({
    name: "workspace_context.filesystem",
    surface: "runtime",
    correlationId: "corr-offline",
    spanId: "span-offline",
    startedAt: "2026-08-18T00:00:00.000Z",
    durationMs: 1,
    success: true,
    inChars: 0,
    outChars: 0,
    args: {},
    result: {}
  });
  assert.equal(calls, 0);
});
