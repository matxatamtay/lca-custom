import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentRunnerRegistry } from "./agent-runner.mjs";
import { RuntimeEventStore } from "./dist/runtime/runtime-event-store.js";

const fakeRunner = {
  capabilities: () => ({ model_agents: true }),
  spawn: () => { throw new Error("not used"); },
  spawnParallel: () => { throw new Error("not used"); },
  list: () => [],
  collect: () => ({ jobs: [] }),
  stop: () => ({ ok: true })
};

test("agent registry reconstructs recoverable jobs and orphaned DAGs after restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-agent-durable-"));
  try {
    const store = new RuntimeEventStore({ path: path.join(root, "events.jsonl") });
    await store.init();
    await store.append({
      type: "agent/job-snapshot",
      correlationId: "corr-job",
      data: {
        runner: "codex",
        id: "job-1",
        status: "running",
        worktree: { finalized: true, patch_path: path.join(root, "job.patch") }
      }
    });
    await store.append({
      type: "agent/dag-snapshot",
      correlationId: "corr-dag",
      data: { dag_id: "dag-1", runner: "codex", status: "running", tasks: [] }
    });
    await store.flush();

    const restoredStore = new RuntimeEventStore({ path: store.path });
    await restoredStore.init();
    const registry = new AgentRunnerRegistry({ events: restoredStore, codex: fakeRunner });
    const job = registry.recover({ job_id: "job-1" });
    assert.equal(job.status, "recoverable");
    assert.equal(job.recovered_after_restart, true);
    assert.equal(registry.list({ runner: "codex" }).jobs[0].id, "job-1");

    const dag = registry.collectDag({ dag_id: "dag-1" });
    assert.equal(dag.status, "orphaned");
    assert.equal(dag.recovered_after_restart, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
