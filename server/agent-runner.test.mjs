// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunnerRegistry, CodexAgentRunnerAdapter } from "./agent-runner.mjs";

class FakeManager {
  constructor() { this.calls = []; }
  delegate(input) { this.calls.push(["spawn", input]); return { id: "job-1", status: "queued" }; }
  delegateParallel(input) { this.calls.push(["parallel", input]); return { batch_id: "batch-1", jobs: [] }; }
  list() { return [{ id: "job-1", status: "queued" }]; }
  collect(input) { this.calls.push(["collect", input]); return { all_done: true, jobs: [] }; }
  stop(id) { this.calls.push(["stop", id]); return { id, status: "stopping" }; }
}

test("routes model-agent lifecycle through a runtime-neutral registry", () => {
  const manager = new FakeManager();
  const registry = new AgentRunnerRegistry({ codex: new CodexAgentRunnerAdapter(manager) });

  assert.equal(registry.capabilities().default_runner, "codex");
  assert.equal(registry.spawn({ task: "inspect" }).id, "job-1");
  assert.equal(registry.spawnParallel({ tasks: [{ task: "a" }] }).batch_id, "batch-1");
  assert.equal(registry.list().jobs.length, 1);
  assert.equal(registry.collect({ job_ids: ["job-1"] }).all_done, true);
  assert.equal(registry.stop({ job_id: "job-1" }).status, "stopping");
  assert.deepEqual(manager.calls.map(([name]) => name), ["spawn", "parallel", "collect", "stop"]);
});

test("rejects unknown runners instead of silently falling back", () => {
  const registry = new AgentRunnerRegistry({ codex: new CodexAgentRunnerAdapter(new FakeManager()) });
  assert.throws(() => registry.spawn({ runner: "missing", task: "x" }), /Unknown agent runner/);
});

class InstantDagRunner {
  constructor() { this.jobs = []; this.started = []; }
  capabilities() { return { model_agents: true }; }
  spawn(input) {
    const job = { id: `job-${this.jobs.length + 1}`, status: input.task.includes("FAIL") ? "failed" : "completed", task: input.task };
    this.jobs.push(job);
    this.started.push(input.name);
    return job;
  }
  spawnParallel() { throw new Error("not used"); }
  list() { return this.jobs; }
  collect({ job_ids = [] }) { return { jobs: this.jobs.filter((job) => job_ids.includes(job.id)), all_done: true }; }
  stop(id) { return this.jobs.find((job) => job.id === id) || { id, status: "cancelled" }; }
}

test("runs dependency-aware agent DAG nodes and unlocks downstream work", async () => {
  const runner = new InstantDagRunner();
  const registry = new AgentRunnerRegistry({ defaultRunner: "fake", runners: { fake: runner }, maxDagConcurrency: 2 });
  const started = registry.spawnDag({
    runner: "fake",
    max_concurrency: 2,
    tasks: [
      { id: "inspect", task: "inspect", files: ["inspect.txt"] },
      { id: "code", task: "code", depends_on: ["inspect"], files: ["code.txt"] },
      { id: "tests", task: "tests", depends_on: ["inspect"], files: ["tests.txt"] }
    ]
  });
  assert.equal(started.status, "running");

  let result;
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    result = registry.collectDag({ dag_id: started.dag_id });
    if (result.status === "completed") break;
  }
  assert.equal(result.status, "completed");
  assert.equal(runner.started[0], "inspect");
  assert.deepEqual(new Set(runner.started.slice(1)), new Set(["code", "tests"]));
});

test("rejects cyclic agent DAGs before spawning workers", () => {
  const registry = new AgentRunnerRegistry({ defaultRunner: "fake", runners: { fake: new InstantDagRunner() } });
  assert.throws(() => registry.spawnDag({ runner: "fake", tasks: [
    { id: "a", task: "a", depends_on: ["b"], files: ["a"] },
    { id: "b", task: "b", depends_on: ["a"], files: ["b"] }
  ] }), /dependency cycle/);
});
