import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspaceStateRegistry } from "./workspace-state-registry.mjs";

test("workspace state registry isolates task/checkpoint state per project root", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "lca-state-registry-"));
  const dataDir = path.join(base, "data");
  const rootA = path.join(base, "repo-a");
  const rootB = path.join(base, "repo-b");
  let tick = 0;
  const registry = createWorkspaceStateRegistry({
    DATA_DIR: dataDir,
    isoNow: () => `2026-09-17T00:00:${String(tick++).padStart(2, "0")}Z`,
    comparePath: (value) => path.resolve(value)
  });

  const a = registry.forRoot(rootA);
  const b = registry.forRoot(rootB);
  assert.notEqual(a.workspaceId, b.workspaceId);
  assert.notEqual(a.paths.checkpointPath, b.paths.checkpointPath);
  assert.equal(registry.forRoot(rootA), a, "same root should reuse the same registry entry");

  await a.taskState.create("Task A", ["a1"]);
  await b.taskState.create("Task B", ["b1"]);
  await a.taskState.recordEdit([path.join(rootA, "src", "a.ts")], { tool: "write_file" });
  await b.taskState.recordEdit([path.join(rootB, "lib", "b.dart")], { tool: "write_file" });
  await a.checkpoint.refresh({ reason: "edit:write_file" });
  await b.checkpoint.refresh({ reason: "edit:write_file" });

  const [taskA, taskB, checkpointA, checkpointB] = await Promise.all([
    a.taskState.read(), b.taskState.read(), a.checkpoint.readCheckpoint(), b.checkpoint.readCheckpoint()
  ]);
  assert.equal(taskA.goal, "Task A");
  assert.equal(taskB.goal, "Task B");
  assert.match(taskA.changed_files[0], /repo-a/);
  assert.match(taskB.changed_files[0], /repo-b/);
  assert.equal(checkpointA.task.goal, "Task A");
  assert.equal(checkpointB.task.goal, "Task B");
  assert.doesNotMatch(JSON.stringify(checkpointA), /repo-b|Task B/);
  assert.doesNotMatch(JSON.stringify(checkpointB), /repo-a|Task A/);

  await rm(base, { recursive: true, force: true });
});
