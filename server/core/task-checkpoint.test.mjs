import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTaskStateCore } from "./task-state.mjs";
import { createCheckpointCore } from "./checkpoint-core.mjs";

test("task state persists structured progress, bounded deduped files, decisions, and verification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-task-state-"));
  let tick = 0;
  const isoNow = () => `2026-09-17T00:00:${String(tick++).padStart(2, "0")}Z`;
  const taskPath = path.join(root, ".agent", "state", "current-task.json");
  const taskState = createTaskStateCore({ TASK_PLAN_PATH: taskPath, isoNow });
  await taskState.create("Ship transactional memory", ["one", "two"]);
  await taskState.update({ setStepDone: 0, status: "in_progress" });
  await taskState.recordEdit(["a.ts", "a.ts", "b.ts"], { tool: "apply_patch" });
  await taskState.recordDecision("Keep deterministic checkpoints", "Avoid hidden LLM state");
  await taskState.recordDiscovery("Patch engine is transactional", ["server/core/patch-core.mjs"]);
  await taskState.recordVerification({ ok: true, failed: 0, ran: 2, gates: [{ name: "test", status: "pass", ok: true }] });
  const state = await taskState.read();
  assert.equal(state.version, 2);
  assert.equal(state.steps[0].done, true);
  assert.equal(state.status, "in_progress");
  assert.deepEqual(state.changed_files, ["a.ts", "b.ts"]);
  assert.equal(state.decisions.at(-1).decision, "Keep deterministic checkpoints");
  assert.equal(state.last_verification.ok, true);
  await rm(root, { recursive: true, force: true });
});

test("checkpoint stays backward-readable while embedding structured task state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-checkpoint-"));
  const taskPath = path.join(root, ".agent", "state", "current-task.json");
  const checkpointPath = path.join(root, "data", "checkpoint.json");
  const taskState = createTaskStateCore({ TASK_PLAN_PATH: taskPath, isoNow: () => "2026-09-17T01:00:00Z" });
  await taskState.create("Goal", ["first", "second"]);
  await taskState.recordEdit(["src/a.ts"], { tool: "write_file" });
  const checkpoints = createCheckpointCore({
    CHECKPOINT_PATH: checkpointPath,
    AGENT_STATE_DIR: path.dirname(taskPath),
    TASK_PLAN_PATH: taskPath,
    isoNow: () => "2026-09-17T01:01:00Z",
    taskState
  });
  const saved = await checkpoints.saveManual({ summary: "manual summary", next_steps: ["second"], files_touched: ["src/a.ts"] });
  assert.equal(saved.ok, true);
  const raw = JSON.parse(await readFile(checkpointPath, "utf8"));
  assert.equal(raw.summary, "manual summary");
  assert.deepEqual(raw.next_steps, ["second"]);
  assert.deepEqual(raw.files_touched, ["src/a.ts"]);
  assert.equal(raw.task.goal, "Goal");
  assert.equal(raw.task.changed_files[0], "src/a.ts");
  await rm(root, { recursive: true, force: true });
});

test("automatic checkpoint writes fail safely instead of throwing into the caller", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-checkpoint-fail-"));
  const taskPath = path.join(root, "task.json");
  const taskState = createTaskStateCore({ TASK_PLAN_PATH: taskPath, isoNow: () => "2026-09-17T02:00:00Z" });
  await taskState.create("Goal", ["first"]);
  const checkpoints = createCheckpointCore({
    CHECKPOINT_PATH: root,
    AGENT_STATE_DIR: root,
    TASK_PLAN_PATH: taskPath,
    isoNow: () => "2026-09-17T02:01:00Z",
    taskState
  });
  const result = await checkpoints.refresh({ reason: "edit" });
  assert.equal(result.ok, false);
  assert.match(result.error, /EISDIR|directory|rename/i);
  await rm(root, { recursive: true, force: true });
});
