import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RuntimeEventStore } from "./runtime-event-store.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-runtime-events-"));
  const file = path.join(root, "events.jsonl");
  const store = new RuntimeEventStore({ path: file });
  await store.init();
  return { root, file, store };
}

test("append-only store persists and reconstructs ordered events", async () => {
  const { root, file, store } = await fixture();
  try {
    const first = await store.append({ type: "tool/started", correlationId: "c1", data: { tool: "read" } });
    const second = await store.append({ type: "tool/completed", correlationId: "c1", data: { ok: true } });
    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.equal(store.query({ correlationId: "c1" }).length, 2);
    assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 2);

    const restored = new RuntimeEventStore({ path: file });
    await restored.init();
    assert.deepEqual(restored.query({ typePrefix: "tool/" }).map((event) => event.seq), [1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
