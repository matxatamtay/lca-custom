// Local Coding Agent — model-agent runner abstraction
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { CodexDelegationManager } from "./codex-delegation.mjs";
import { validateTaskDag } from "./core/workspace-protocol.mjs";

export const CODEX_RUNNER_CAPABILITIES = Object.freeze({
  model_agents: true,
  parallel: true,
  structured_result: true,
  cancellation: true,
  task_dag: true,
  worktree_isolation: true,
  explicit_merge: true,
  conflict_check: true,
  provider_routing: true,
  provider_fallback: true,
  resume: false,
  followup: false,
  interrupt: false,
  sandbox_modes: Object.freeze(["read-only", "workspace-write", "danger-full-access"])
});

export class AgentRunnerRegistry {
  constructor(options = {}) {
    this.events = options.events || null;
    this.correlationId = typeof options.correlationId === "function" ? options.correlationId : () => undefined;
    this.recoveredJobs = new Map();
    this.recoveredDags = new Map();
    this.restoreRuntimeState();
    const codexOptions = {
      ...(options.codexOptions || {}),
      onJobChange: (job) => this.recordJobSnapshot("codex", job)
    };
    const codex = options.codex || new CodexAgentRunnerAdapter(options.codexManager || new CodexDelegationManager(codexOptions));
    this.runners = new Map([["codex", codex], ...Object.entries(options.runners || {})]);
    this.defaultRunner = options.defaultRunner || "codex";
    this.dags = new Map();
    this.maxDagTasks = positiveInt(options.maxDagTasks, 32);
    this.maxDagConcurrency = positiveInt(options.maxDagConcurrency, 8);
  }

  capabilities() {
    return {
      default_runner: this.defaultRunner,
      runners: [...this.runners.entries()].map(([name, runner]) => ({ name, ...runner.capabilities() }))
    };
  }

  spawn(input = {}) {
    return this.requireRunner(input.runner).spawn(input);
  }

  spawnParallel(input = {}) {
    return this.requireRunner(input.runner).spawnParallel(input);
  }

  list(input = {}) {
    const requested = cleanString(input.runner);
    if (requested) return { runner: requested, jobs: this.combinedJobs(requested, this.requireRunner(requested).list()) };
    return {
      jobs: [...this.runners.entries()].flatMap(([runnerName, runner]) =>
        this.combinedJobs(runnerName, runner.list()).map((job) => ({ runner: runnerName, ...job })))
    };
  }

  collect(input = {}) {
    return this.requireRunner(input.runner).collect(input);
  }

  stop(input = {}) {
    return this.requireRunner(input.runner).stop(input.job_id);
  }

  merge(input = {}) {
    const runner = this.requireRunner(input.runner);
    if (typeof runner.merge !== "function") throw new Error("Selected agent runner does not support isolated result merge.");
    return runner.merge(input);
  }

  cleanup(input = {}) {
    const runner = this.requireRunner(input.runner);
    if (typeof runner.cleanup !== "function") throw new Error("Selected agent runner does not support isolated worktree cleanup.");
    return runner.cleanup(input.job_id);
  }

  spawnDag(input = {}) {
    const tasks = normalizeDagTasks(input.tasks, this.maxDagTasks);
    validateTaskDag(tasks);
    assertDagWriteScopes(tasks, input, input.allow_overlap === true);
    const runnerName = cleanString(input.runner) || this.defaultRunner;
    this.requireRunner(runnerName);
    const now = new Date().toISOString();
    const dag = {
      id: randomUUID(),
      runnerName,
      status: "running",
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      maxConcurrency: Math.min(positiveInt(input.max_concurrency, this.maxDagConcurrency), this.maxDagConcurrency),
      common: dagCommonInput(input),
      cancelled: false,
      tasks: new Map(tasks.map((task) => [task.id, {
        ...task,
        status: "pending",
        jobId: null,
        error: null,
        startedAt: null,
        finishedAt: null
      }]))
    };
    this.dags.set(dag.id, dag);
    this.recordDagSnapshot(dag);
    this.launchDag(dag);
    return publicDag(dag, false, null);
  }

  collectDag(input = {}) {
    const recovered = this.recoveredDags.get(cleanString(input.dag_id));
    if (!this.dags.has(cleanString(input.dag_id)) && recovered) {
      return { ...structuredClone(recovered), recovered_after_restart: true };
    }
    const dag = this.requireDag(input.dag_id);
    const runner = this.requireRunner(dag.runnerName);
    const jobIds = [...dag.tasks.values()].map((task) => task.jobId).filter(Boolean);
    const results = input.include_results === false || !jobIds.length
      ? null
      : runner.collect({ job_ids: jobIds });
    return publicDag(dag, true, results);
  }

  stopDag(input = {}) {
    const dag = this.requireDag(input.dag_id);
    dag.cancelled = true;
    dag.status = "stopping";
    dag.updatedAt = new Date().toISOString();
    this.recordDagSnapshot(dag);
    const runner = this.requireRunner(dag.runnerName);
    for (const task of dag.tasks.values()) {
      if (task.jobId && ["queued", "running", "stopping"].includes(task.status)) runner.stop(task.jobId);
    }
    return publicDag(dag, false, null);
  }

  requireRunner(value) {
    const name = cleanString(value) || this.defaultRunner;
    const runner = this.runners.get(name);
    if (!runner) throw new Error(`Unknown agent runner '${name}'. Available runners: ${[...this.runners.keys()].join(", ")}.`);
    return runner;
  }

  requireDag(id) {
    const dag = this.dags.get(cleanString(id));
    if (!dag) throw new Error(`No agent DAG with id ${id}`);
    return dag;
  }

  launchDag(dag) {
    Promise.resolve().then(() => this.runDag(dag)).catch((error) => {
      dag.status = "failed";
      dag.error = error instanceof Error ? error.message : String(error);
      dag.finishedAt = new Date().toISOString();
      dag.updatedAt = dag.finishedAt;
    });
  }

  async runDag(dag) {
    const runner = this.requireRunner(dag.runnerName);
    while (true) {
      const jobs = new Map(runner.list().map((job) => [job.id, job]));
      for (const task of dag.tasks.values()) {
        if (!task.jobId) continue;
        const job = jobs.get(task.jobId);
        if (!job) continue;
        if (["completed", "failed", "cancelled"].includes(job.status)) {
          task.status = job.status === "completed" ? "completed" : job.status;
          task.error = job.error || null;
          task.finishedAt = task.finishedAt || new Date().toISOString();
        } else {
          task.status = job.status;
        }
      }

      if (dag.cancelled) {
        for (const task of dag.tasks.values()) {
          if (task.status === "pending") task.status = "cancelled";
        }
      } else {
        markBlockedDagTasks(dag.tasks);
        let active = [...dag.tasks.values()].filter((task) => ["queued", "running", "stopping"].includes(task.status)).length;
        const ready = [...dag.tasks.values()].filter((task) => task.status === "pending" && dependenciesSatisfied(task, dag.tasks));
        for (const task of ready) {
          if (active >= dag.maxConcurrency) break;
          const job = runner.spawn({ ...dag.common, ...task, name: task.name || task.id });
          task.jobId = job.id;
          task.status = job.status || "queued";
          task.startedAt = new Date().toISOString();
          active += 1;
        }
      }

      dag.updatedAt = new Date().toISOString();
      this.recordDagSnapshot(dag);
      const pending = [...dag.tasks.values()].some((task) => task.status === "pending");
      const active = [...dag.tasks.values()].some((task) => ["queued", "running", "stopping"].includes(task.status));
      if (!pending && !active) break;
      await sleep(100);
    }

    const failedRequired = [...dag.tasks.values()].some((task) => task.status === "failed" && !task.allow_failure);
    const cancelled = dag.cancelled || [...dag.tasks.values()].some((task) => task.status === "cancelled");
    dag.status = cancelled ? "cancelled" : failedRequired ? "failed" : "completed";
    dag.finishedAt = new Date().toISOString();
    dag.updatedAt = dag.finishedAt;
    this.recordDagSnapshot(dag);
  }

  resume(input = {}) {
    const runner = this.requireRunner(input.runner);
    if (typeof runner.resume !== "function") return { supported: false, runner: cleanString(input.runner) || this.defaultRunner };
    return runner.resume(input);
  }

  followup(input = {}) {
    const runner = this.requireRunner(input.runner);
    if (typeof runner.followup !== "function") return { supported: false, runner: cleanString(input.runner) || this.defaultRunner };
    return runner.followup(input);
  }

  interrupt(input = {}) {
    const runner = this.requireRunner(input.runner);
    if (typeof runner.interrupt !== "function") return { supported: false, runner: cleanString(input.runner) || this.defaultRunner };
    return runner.interrupt(input);
  }

  recover(input = {}) {
    const id = cleanString(input.job_id);
    const snapshot = this.recoveredJobs.get(id);
    if (!snapshot) throw new Error(`No recovered delegated agent job ${id}.`);
    return structuredClone(snapshot);
  }

  combinedJobs(runnerName, liveJobs) {
    const liveIds = new Set(liveJobs.map((job) => job.id));
    const recovered = [...this.recoveredJobs.values()]
      .filter((job) => job.runner === runnerName && !liveIds.has(job.id));
    return [...liveJobs, ...recovered];
  }

  recordJobSnapshot(runner, job) {
    const snapshot = { runner, ...structuredClone(job) };
    this.recoveredJobs.set(job.id, snapshot);
    void this.events?.append({ type: "agent/job-snapshot", correlationId: this.correlationId(), data: snapshot }).catch(() => undefined);
  }

  recordDagSnapshot(dag) {
    void this.events?.append({
      type: "agent/dag-snapshot",
      correlationId: this.correlationId(),
      data: publicDag(dag, false, null)
    }).catch(() => undefined);
  }

  restoreRuntimeState() {
    if (!this.events) return;
    const events = this.events.query({ typePrefix: "agent/", limit: 10_000 });
    for (const event of events) {
      if (event.type === "agent/dag-snapshot") {
        const dag = structuredClone(event.data);
        if (typeof dag?.dag_id === "string") {
          if (["running", "stopping"].includes(dag.status)) dag.status = "orphaned";
          this.recoveredDags.set(dag.dag_id, dag);
        }
        continue;
      }
      if (event.type !== "agent/job-snapshot") continue;
      const job = structuredClone(event.data);
      if (!job?.id || typeof job.id !== "string") continue;
      if (["queued", "running", "stopping"].includes(job.status)) {
        job.status = job.worktree?.finalized && job.worktree?.patch_path ? "recoverable" : "orphaned";
        job.recovered_after_restart = true;
      }
      this.recoveredJobs.set(job.id, job);
    }
  }
}

export class CodexAgentRunnerAdapter {
  constructor(manager = new CodexDelegationManager()) {
    this.manager = manager;
  }

  capabilities() {
    return {
      ...CODEX_RUNNER_CAPABILITIES,
      providers: typeof this.manager.providerStatus === "function" ? this.manager.providerStatus() : null,
      sandbox_modes: [...CODEX_RUNNER_CAPABILITIES.sandbox_modes]
    };
  }

  spawn(input) {
    return this.manager.delegate(input);
  }

  spawnParallel(input) {
    return this.manager.delegateParallel(input);
  }

  list() {
    return this.manager.list();
  }

  collect(input) {
    return this.manager.collect(input);
  }

  stop(jobId) {
    return this.manager.stop(jobId);
  }

  merge(input) {
    return this.manager.merge(input);
  }

  cleanup(jobId) {
    return this.manager.cleanup(jobId);
  }
}

function normalizeDagTasks(value, maxTasks) {
  if (!Array.isArray(value) || value.length < 1) throw new Error("Agent DAG requires at least one task.");
  if (value.length > maxTasks) throw new Error(`Agent DAG supports at most ${maxTasks} tasks.`);
  return value.map((task, index) => {
    const id = cleanString(task?.id) || `task-${index + 1}`;
    const prompt = cleanString(task?.task);
    if (!prompt) throw new Error(`Agent DAG task ${id} requires a non-empty task.`);
    return {
      ...task,
      id,
      task: prompt,
      depends_on: dedupe(Array.isArray(task.depends_on) ? task.depends_on.map(cleanString).filter(Boolean) : []),
      allow_failure: task.allow_failure === true,
      files: Array.isArray(task.files) ? task.files : []
    };
  });
}

function dagCommonInput(input) {
  return {
    cwd: input.cwd,
    context: input.context,
    model: input.model,
    provider: input.provider,
    provider_chain: input.provider_chain,
    reasoning_effort: input.reasoning_effort,
    sandbox: input.sandbox,
    isolation: input.isolation,
    inherit_dirty: input.inherit_dirty,
    network_access: input.network_access,
    additional_directories: input.additional_directories
  };
}

function dependenciesSatisfied(task, tasks) {
  return task.depends_on.every((id) => {
    const dependency = tasks.get(id);
    if (!dependency) return false;
    if (dependency.status === "completed") return true;
    return dependency.status === "failed" && dependency.allow_failure;
  });
}

function markBlockedDagTasks(tasks) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks.values()) {
      if (task.status !== "pending") continue;
      const blocker = task.depends_on
        .map((id) => tasks.get(id))
        .find((dependency) => dependency && (
          dependency.status === "blocked"
          || dependency.status === "cancelled"
          || (dependency.status === "failed" && !dependency.allow_failure)
        ));
      if (!blocker) continue;
      task.status = "blocked";
      task.error = `Dependency ${blocker.id} ended with ${blocker.status}.`;
      task.finishedAt = new Date().toISOString();
      changed = true;
    }
  }
}

function assertDagWriteScopes(tasks, common, allowOverlap) {
  if (allowOverlap) return;
  const writable = tasks.filter((task) => (task.sandbox || common.sandbox || "danger-full-access") !== "read-only");
  const shared = writable.filter((task) => (task.isolation || common.isolation || "worktree") !== "worktree");
  if (shared.length < 2) return;
  for (const task of shared) {
    if (!task.files.length) throw new Error(`Parallel shared writable DAG task ${task.id} must declare files or set allow_overlap=true explicitly.`);
  }
  for (let left = 0; left < shared.length; left += 1) {
    for (let right = left + 1; right < shared.length; right += 1) {
      const overlap = pathOverlap(shared[left].files, shared[right].files);
      if (overlap) throw new Error(`Agent DAG write scopes overlap at ${overlap}.`);
    }
  }
}

function pathOverlap(left, right) {
  for (const a of left) {
    for (const b of right) {
      const normalizedA = String(a);
      const normalizedB = String(b);
      if (normalizedA === normalizedB || normalizedA.startsWith(`${normalizedB}/`) || normalizedB.startsWith(`${normalizedA}/`)) return normalizedA.length <= normalizedB.length ? normalizedA : normalizedB;
    }
  }
  return null;
}

function publicDag(dag, includeResults, results) {
  const tasks = [...dag.tasks.values()].map((task) => ({
    id: task.id,
    task: task.task,
    name: task.name || null,
    status: task.status,
    allow_failure: task.allow_failure,
    depends_on: task.depends_on,
    files: task.files,
    job_id: task.jobId,
    started_at: task.startedAt,
    finished_at: task.finishedAt,
    error: task.error
  }));
  return {
    dag_id: dag.id,
    runner: dag.runnerName,
    status: dag.status,
    max_concurrency: dag.maxConcurrency,
    created_at: dag.createdAt,
    updated_at: dag.updatedAt,
    finished_at: dag.finishedAt,
    tasks,
    summary: summarizeDag(tasks),
    ...(dag.error ? { error: dag.error } : {}),
    ...(includeResults ? { results } : {})
  };
}

function summarizeDag(tasks) {
  const counts = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] || 0) + 1;
  return counts;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function dedupe(values) {
  return [...new Set(values)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
