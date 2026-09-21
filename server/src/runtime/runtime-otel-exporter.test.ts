import test from "node:test";
import assert from "node:assert/strict";

import { RuntimeOtelExporter } from "./runtime-otel-exporter.js";

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
    startedAt: "2026-08-18T00:00:00.000Z",
    durationMs: 12.5,
    success: true,
    inChars: 123,
    outChars: 456,
    args: { secret: "must-not-export" },
    result: { private: "must-not-export" }
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "http://127.0.0.1:4318/v1/traces");
  const text = JSON.stringify(requests[0]?.body);
  assert.doesNotMatch(text, /must-not-export/);
  assert.match(text, /workspace_read/);
  assert.match(text, /lca\.input_chars/);
});
