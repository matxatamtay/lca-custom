import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ActionExecutionPipeline } from "./action-execution-pipeline.js";
import { RuntimeEventStore } from "./runtime-event-store.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-action-pipeline-"));
  const store = new RuntimeEventStore({ path: path.join(root, "events.jsonl") });
  await store.init();
  return { root, store, pipeline: new ActionExecutionPipeline(store) };
}

test("pipeline records one correlation across nested actions", async () => {
  const { root, store, pipeline } = await fixture();
  try {
    await pipeline.execute({ name: "outer", surface: "facade" }, async () => {
      await pipeline.execute({ name: "inner", surface: "backend" }, async () => ({ ok: true }));
    });
    const events = store.query({ typePrefix: "tool/" });
    assert.equal(events.length, 4);
    assert.equal(new Set(events.map((event) => event.correlationId)).size, 1);

    const outerStarted = events.find((event) => event.type === "tool/started" && event.data.name === "outer");
    const innerStarted = events.find((event) => event.type === "tool/started" && event.data.name === "inner");
    const outerCompleted = events.find((event) => event.type === "tool/completed" && event.data.name === "outer");
    const innerCompleted = events.find((event) => event.type === "tool/completed" && event.data.name === "inner");
    assert.ok(outerStarted?.data.spanId);
    assert.ok(innerStarted?.data.spanId);
    assert.equal(innerStarted?.parentId, outerStarted?.data.spanId);
    assert.equal(innerCompleted?.parentId, outerStarted?.data.spanId);
    assert.equal(outerCompleted?.parentId, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
