// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { ToolMetrics, measureJsonChars } from "./tool-metrics.mjs";

test("profiles latency, payload size, failures, and keeps trace metadata only", () => {
  const metrics = new ToolMetrics({ recentLimit: 10 });
  metrics.record({ tool: "search", surface: "backend", ok: true, durationMs: 100, inChars: 10, outChars: 1000 });
  metrics.record({ tool: "search", surface: "backend", ok: true, durationMs: 2100, inChars: 20, outChars: 60000 });
  metrics.record({ tool: "search", surface: "backend", ok: false, durationMs: 2500, inChars: 30, outChars: 70000 });

  const profile = metrics.profile();
  const search = profile.tools.find((item) => item.tool === "search");
  assert.equal(search.calls, 3);
  assert.equal(search.failed, 1);
  assert.equal(search.p95_duration_ms, 2500);
  assert.ok(profile.recommendations.some((item) => item.tool === "search"));

  const trace = metrics.trace({ limit: 2 });
  assert.equal(trace.entries.length, 2);
  assert.deepEqual(Object.keys(trace.entries[0]).sort(), ["duration_ms", "input_chars", "ok", "output_chars", "seq", "surface", "tool", "ts"].sort());
});

test("bounded trace evicts oldest entries", () => {
  const metrics = new ToolMetrics({ recentLimit: 2 });
  metrics.record({ tool: "a", ok: true });
  metrics.record({ tool: "b", ok: true });
  metrics.record({ tool: "c", ok: true });
  assert.deepEqual(metrics.trace({ limit: 10 }).entries.map((item) => item.tool), ["c", "b"]);
});

test("measureJsonChars counts payload without persisting its content", () => {
  const secret = "super-secret-token";
  const size = measureJsonChars({ token: secret, values: [1, 2, 3] });
  assert.ok(size > secret.length);
});
