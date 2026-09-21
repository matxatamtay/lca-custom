import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEditTransactionCore } from "./edit-transaction.mjs";
import { hashBytes, readPathState } from "./file-state.mjs";
import { createPathLockManager } from "./path-locks.mjs";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("readPathState captures raw-byte hash and text metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-file-state-"));
  try {
    const file = path.join(root, "windows.txt");
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\r\ntwo\r\n", "utf8")]);
    await writeFile(file, raw);
    const state = await readPathState(file);
    assert.equal(state.exists, true);
    assert.equal(state.kind, "file");
    assert.equal(state.sha256, hashBytes(raw));
    assert.equal(state.bom, true);
    assert.equal(state.eol, "crlf");
    assert.equal(state.finalNewline, true);
    assert.equal(state.text, "one\r\ntwo\r\n");

    const missing = await readPathState(path.join(root, "missing.txt"));
    assert.equal(missing.exists, false);
    assert.equal(missing.kind, "missing");
    assert.equal(missing.sha256, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("path locks serialize the same path while allowing independent paths", async () => {
  const manager = createPathLockManager();
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-path-lock-"));
  try {
    const a = path.join(root, "a.txt");
    const b = path.join(root, "b.txt");
    const events = [];

    const first = manager.withPaths([a], async () => {
      events.push("a1-start");
      await delay(40);
      events.push("a1-end");
    });
    await delay(5);
    const second = manager.withPaths([a], async () => {
      events.push("a2-start");
      events.push("a2-end");
    });
    const independent = manager.withPaths([b], async () => {
      events.push("b-start");
      events.push("b-end");
    });

    await Promise.all([first, second, independent]);
    assert.ok(events.indexOf("a1-end") < events.indexOf("a2-start"));
    assert.ok(events.indexOf("b-start") < events.indexOf("a1-end"));
    assert.equal(manager.pendingCount(), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("multi-path locks use deterministic ordering and avoid deadlock", async () => {
  const manager = createPathLockManager();
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-multi-lock-"));
  try {
    const a = path.join(root, "a.txt");
    const b = path.join(root, "b.txt");
    const completed = [];
    await Promise.race([
      Promise.all([
        manager.withPaths([b, a], async () => {
          await delay(20);
          completed.push("first");
        }),
        manager.withPaths([a, b], async () => {
          completed.push("second");
        })
      ]),
      delay(1000).then(() => { throw new Error("lock acquisition deadlocked"); })
    ]);
    assert.equal(completed.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("edit transaction snapshots state after acquiring its locks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-edit-transaction-"));
  try {
    const file = path.join(root, "value.txt");
    await writeFile(file, "before\n", "utf8");
    const transaction = createEditTransactionCore();
    const observed = await transaction.run([file], async ({ preState }) => preState.get(file));
    assert.equal(observed.text, "before\n");
    assert.equal(observed.eol, "lf");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
