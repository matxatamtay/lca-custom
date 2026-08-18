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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
