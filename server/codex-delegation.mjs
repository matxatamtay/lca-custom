// Local Coding Agent — Codex delegation manager
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import path from "node:path";

import { Codex } from "@openai/codex-sdk";
import {
  classifyProviderFailure,
  loadAgentProviderConfig,
  providerCodexOptions,
  providerCooldownMs,
  publicAgentProviderStatus,
  redactProviderError,
  resolveAgentProviderChain
} from "./agent-provider-config.mjs";
import {
  cleanupAgentWorktree,
  createAgentWorktree,
  finalizeAgentWorktree,
  mergeAgentWorktree,
  publicWorktreeResult
} from "./agent-worktree.mjs";

const MAX_JOBS = 100;
const DEFAULT_MAX_PARALLEL = 8;
const OUTPUT_BUFFER = 80_000;

const RESULT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    changed_files: { type: "array", items: { type: "string" } },
    tests: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } }
  },
  required: ["summary", "changed_files", "tests", "blockers", "risks"]
});

export class CodexDelegationManager {
  constructor(options = {}) {
    this.jobs = new Map();
    this.maxParallel = positiveInt(options.maxParallel, DEFAULT_MAX_PARALLEL);
    this.providerConfig = options.providerConfig || loadAgentProviderConfig(options.env || process.env);
    this.providerHealth = new Map();
    this.providerCooldowns = options.providerCooldowns || {};
    this.createCodex = options.createCodex || ((provider) => new Codex(providerCodexOptions(provider, options.codexOptions || {})));
    this.onJobChange = typeof options.onJobChange === "function" ? options.onJobChange : () => {};
  }

  providerStatus() {
    return publicAgentProviderStatus(this.providerConfig, this.providerHealth);
  }

  delegate(input) {
    this.prune();
    this.assertCapacity(1);
    const spec = normalizeTask(input);
    const job = this.createJob(spec, null);
    this.launch(job);
    return publicJob(job, false);
  }

  async merge(input = {}) {
    const job = this.requireJob(input.job_id);
    if (!isTerminal(job.status)) throw new Error(`Codex job ${job.id} is still ${job.status}.`);
    if (!job.worktree) throw new Error(`Codex job ${job.id} did not run in an isolated worktree.`);
    const result = await mergeAgentWorktree(job.worktree, {
      targetCwd: input.target_cwd || job.worktree.sourceRoot,
      cleanup: input.cleanup !== false
    });
    job.mergeResult = result;
    job.updatedAt = new Date().toISOString();
    this.notifyJobChange(job);
    return { job_id: job.id, ...result, worktree: publicWorktreeResult(job.worktree) };
  }

  async cleanup(id) {
    const job = this.requireJob(id);
    if (!job.worktree) return { job_id: job.id, ok: true, cleaned: false, reason: "shared_workspace" };
    const result = await cleanupAgentWorktree(job.worktree);
    job.updatedAt = new Date().toISOString();
    this.notifyJobChange(job);
    return { job_id: job.id, ...result };
  }

  delegateParallel(input) {
    this.prune();
    const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
    if (tasks.length < 1) throw new Error("Codex parallel delegation requires at least one task.");
    if (tasks.length > this.maxParallel) {
      throw new Error(`Codex parallel delegation supports at most ${this.maxParallel} tasks per batch.`);
    }
    this.assertCapacity(tasks.length);

    const common = {
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
    const specs = tasks.map((task) => normalizeTask({ ...common, ...task }));
    assertDisjointWriteScopes(specs, input.allow_overlap === true);

    const batchId = randomUUID();
    const jobs = specs.map((spec) => this.createJob(spec, batchId));
    for (const job of jobs) this.launch(job);
    return {
      batch_id: batchId,
      count: jobs.length,
      jobs: jobs.map((job) => publicJob(job, false))
    };
  }

  list() {
    this.prune();
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((job) => publicJob(job, false));
  }

  collect(input = {}) {
    this.prune();
    const ids = normalizeIds(input.job_ids);
    const batchId = cleanString(input.batch_id);
    let jobs = [...this.jobs.values()];
    if (ids.length) jobs = jobs.filter((job) => ids.includes(job.id));
    if (batchId) jobs = jobs.filter((job) => job.batchId === batchId);
    if (!ids.length && !batchId) throw new Error("Provide batch_id or job_ids to collect Codex results.");

    const requested = ids.length || jobs.length;
    const completed = jobs.filter((job) => isTerminal(job.status)).length;
    return {
      batch_id: batchId || null,
      requested,
      found: jobs.length,
      completed,
      pending: jobs.length - completed,
      all_done: jobs.length === requested && completed === requested,
      jobs: jobs.map((job) => publicJob(job, true))
    };
  }

  stop(id) {
    const job = this.requireJob(id);
    if (!isTerminal(job.status)) {
      job.status = "stopping";
      job.updatedAt = new Date().toISOString();
      job.abortController.abort();
      this.notifyJobChange(job);
    }
    return publicJob(job, false);
  }

  stopAll() {
    for (const job of this.jobs.values()) {
      if (!isTerminal(job.status)) job.abortController.abort();
    }
  }

  createJob(spec, batchId) {
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      batchId,
      name: spec.name,
      task: spec.task,
      spec,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      threadId: null,
      abortController: new AbortController(),
      output: "",
      result: null,
      usage: null,
      error: null,
      changedFiles: new Set(),
      commands: [],
      worktree: null,
      mergeResult: null,
      isolationError: null,
      providerChain: [],
      activeProvider: null,
      providerAttempts: []
    };
    this.jobs.set(job.id, job);
    this.notifyJobChange(job);
    return job;
  }

  launch(job) {
    Promise.resolve()
      .then(() => this.runJob(job))
      .catch((error) => {
        if (isTerminal(job.status)) return;
        job.status = job.abortController.signal.aborted ? "cancelled" : "failed";
        job.error = errorMessage(error);
        job.finishedAt = new Date().toISOString();
        job.updatedAt = job.finishedAt;
      });
  }

  async runJob(job) {
    const { spec } = job;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    this.notifyJobChange(job);
    let effectiveSpec = spec;
    let completed = false;
    try {
      if (spec.isolation === "worktree" && spec.sandbox !== "read-only") {
        job.worktree = await createAgentWorktree({
          cwd: spec.cwd,
          jobId: job.id,
          files: spec.files,
          additionalDirectories: spec.additionalDirectories,
          inheritDirty: spec.inheritDirty
        });
        effectiveSpec = {
          ...spec,
          cwd: job.worktree.cwd,
          files: job.worktree.files,
          additionalDirectories: job.worktree.additionalDirectories
        };
      }

      const providers = this.availableProviders(
        resolveAgentProviderChain(this.providerConfig, spec),
        Boolean(spec.provider)
      );
      job.providerChain = providers.map((provider) => provider.name);

      for (let index = 0; index < providers.length; index += 1) {
        const provider = providers[index];
        try {
          await this.runProviderAttempt(job, effectiveSpec, provider);
          this.providerHealth.delete(provider.name);
          completed = true;
          break;
        } catch (error) {
          if (job.abortController.signal.aborted) throw error;
          const failure = classifyProviderFailure(error);
          const safeError = redactProviderError(error, [provider.apiKey]);
          const attempt = job.providerAttempts.at(-1);
          if (attempt) {
            attempt.status = "failed";
            attempt.category = failure.category;
            attempt.error = safeError;
            attempt.finished_at = new Date().toISOString();
          }
          if (failure.retryable) this.cooldownProvider(provider.name, failure.category);
          const hasFallback = failure.retryable && index + 1 < providers.length;
          if (hasFallback) {
            job.status = "running";
            job.error = null;
            continue;
          }
          job.error = safeError;
          throw new Error(safeError);
        }
      }

      if (job.abortController.signal.aborted) job.status = "cancelled";
      else if (!completed && !isTerminal(job.status)) job.status = "failed";
    } catch (error) {
      job.status = job.abortController.signal.aborted ? "cancelled" : "failed";
      job.error = job.error || redactProviderError(error, this.providerSecrets());
      throw error;
    } finally {
      if (job.worktree) {
        try {
          const finalized = await finalizeAgentWorktree(job.worktree, spec.files);
          job.changedFiles = new Set(finalized.changed_files.map((file) => path.join(job.worktree.sourceRoot, file)));
          if (finalized.scope_violations.length) {
            job.status = "failed";
            job.error = `Delegated agent wrote outside declared scope: ${finalized.scope_violations.join(", ")}`;
          }
        } catch (error) {
          job.isolationError = errorMessage(error);
          if (completed && job.status === "running") {
            job.status = "failed";
            job.error = `Failed to finalize isolated worktree: ${job.isolationError}`;
          }
        }
      }
      if (completed && job.status === "running") job.status = "completed";
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      job.result = parseStructuredResult(job.output, job.changedFiles);
      this.notifyJobChange(job);
    }
  }

  notifyJobChange(job) {
    try { this.onJobChange(publicJob(job, true)); } catch { /* observer failures cannot break delegated work */ }
  }

  async runProviderAttempt(job, effectiveSpec, provider) {
    const attempt = {
      provider: provider.name,
      model: effectiveSpec.model || provider.model || null,
      status: "running",
      category: null,
      error: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      thread_id: null,
      usage: null,
      output: "",
      warnings: []
    };
    job.providerAttempts.push(attempt);
    job.activeProvider = provider.name;
    job.threadId = null;
    job.usage = null;
    job.error = null;
    if (!provider.keyConfigured) {
      throw new Error(`Agent provider '${provider.name}' is missing environment variable ${provider.apiKeyEnv}.`);
    }

    const codex = this.createCodex(provider);
    const thread = codex.startThread({
      workingDirectory: effectiveSpec.cwd,
      sandboxMode: effectiveSpec.sandbox,
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      networkAccessEnabled: effectiveSpec.networkAccess,
      ...(attempt.model ? { model: attempt.model } : {}),
      ...(effectiveSpec.reasoningEffort ? { modelReasoningEffort: effectiveSpec.reasoningEffort } : {}),
      ...(effectiveSpec.additionalDirectories.length ? { additionalDirectories: effectiveSpec.additionalDirectories } : {})
    });
    const streamed = await thread.runStreamed(buildPrompt(effectiveSpec), {
      ...(provider.outputSchema ? { outputSchema: RESULT_SCHEMA } : {}),
      signal: job.abortController.signal
    });
    for await (const event of streamed.events) {
      job.updatedAt = new Date().toISOString();
      this.consumeEvent(job, attempt, provider, event);
    }
    if (attempt.error) throw new Error(attempt.error);
    attempt.status = "completed";
    attempt.finished_at = new Date().toISOString();
    job.threadId = attempt.thread_id;
    job.usage = attempt.usage;
    job.output = attempt.output;
  }

  availableProviders(providers, explicitSingleProvider) {
    if (explicitSingleProvider) return providers;
    const now = Date.now();
    const available = providers.filter((provider) => {
      const state = this.providerHealth.get(provider.name);
      return !state || Date.parse(state.until) <= now;
    });
    return available.length ? available : providers;
  }

  cooldownProvider(name, category) {
    const cooldownMs = providerCooldownMs(category, this.providerCooldowns);
    if (!cooldownMs) return;
    this.providerHealth.set(name, {
      category,
      until: new Date(Date.now() + cooldownMs).toISOString()
    });
  }

  providerSecrets() {
    return [...this.providerConfig.providers.values()].map((provider) => provider.apiKey).filter(Boolean);
  }

  consumeEvent(job, attempt, provider, event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "thread.started") {
      attempt.thread_id = cleanString(event.thread_id) || attempt.thread_id;
      return;
    }
    if (event.type === "turn.completed") {
      attempt.usage = event.usage || null;
      return;
    }
    if (event.type === "turn.failed") {
      attempt.error = redactProviderError(event.error?.message || event.error || "Codex turn failed.", [provider.apiKey]);
      return;
    }
    if (event.type === "error") {
      attempt.error = redactProviderError(event.message || "Codex stream failed.", [provider.apiKey]);
      return;
    }
    if (event.type !== "item.completed" && event.type !== "item.updated") return;

    const item = event.item;
    if (!item || typeof item !== "object") return;
    if (item.type === "agent_message" && item.text) {
      attempt.output = appendLimited(attempt.output, String(item.text), OUTPUT_BUFFER);
    } else if (item.type === "file_change" && Array.isArray(item.changes)) {
      for (const change of item.changes) {
        const changed = cleanString(change?.path);
        if (changed) job.changedFiles.add(changed);
      }
    } else if (item.type === "command_execution" && item.status !== "in_progress") {
      job.commands.push({
        provider: attempt.provider,
        command: String(item.command || ""),
        exit_code: Number.isInteger(item.exit_code) ? item.exit_code : null,
        status: item.status || null
      });
      if (job.commands.length > 30) job.commands.splice(0, job.commands.length - 30);
    } else if (item.type === "error" && item.message) {
      const message = redactProviderError(item.message, [provider.apiKey]);
      if (isNonFatalCodexWarning(message)) {
        attempt.warnings.push(message);
        if (attempt.warnings.length > 20) attempt.warnings.splice(0, attempt.warnings.length - 20);
      } else {
        attempt.error = message;
      }
    }
  }

  requireJob(id) {
    const job = this.jobs.get(String(id || ""));
    if (!job) throw new Error(`No Codex job with id ${id}`);
    return job;
  }

  assertCapacity(incoming) {
    const active = [...this.jobs.values()].filter((job) => !isTerminal(job.status)).length;
    if (active + incoming > this.maxParallel) {
      throw new Error(`Codex delegation capacity exceeded: ${active} active, ${incoming} requested, max ${this.maxParallel}.`);
    }
  }

  prune() {
    if (this.jobs.size <= MAX_JOBS) return;
    const terminal = [...this.jobs.values()]
      .filter((job) => isTerminal(job.status))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    while (this.jobs.size > MAX_JOBS && terminal.length) {
      const job = terminal.shift();
      if (job) this.jobs.delete(job.id);
    }
  }
}

function normalizeTask(input = {}) {
  const task = cleanString(input.task);
  if (!task) throw new Error("Codex delegation requires a non-empty task.");
  const cwd = path.resolve(cleanString(input.cwd) || process.cwd());
  const sandbox = normalizeSandbox(input.sandbox);
  const files = normalizePaths(input.files, cwd);
  return {
    task,
    name: cleanString(input.name) || task.slice(0, 60),
    cwd,
    files,
    context: cleanString(input.context) || "",
    model: cleanString(input.model) || "",
    provider: cleanString(input.provider) || "",
    provider_chain: normalizeIds(input.provider_chain),
    reasoningEffort: normalizeReasoning(input.reasoning_effort),
    sandbox,
    isolation: normalizeIsolation(input.isolation, sandbox),
    inheritDirty: input.inherit_dirty !== false,
    networkAccess: input.network_access !== false,
    additionalDirectories: normalizePaths(input.additional_directories, cwd),
    parentTaskId: cleanString(input.parent_task_id) || "",
    parentSessionId: cleanString(input.parent_session_id) || ""
  };
}

function buildPrompt(spec) {
  const scope = spec.files.length
    ? spec.files.map((file) => `- ${file}`).join("\n")
    : "- No explicit file list was supplied. Keep the change as narrow as possible.";
  const context = spec.context ? `\nUseful context from the parent agent:\n${spec.context}\n` : "";
  return [
    "You are a delegated coding worker inside Local Coding Agent.",
    "Complete only the scoped task below. The parent agent will review and combine your work with other parallel lanes.",
    "",
    `Task: ${spec.task}`,
    "",
    "Declared file scope:",
    scope,
    context,
    "Rules:",
    "- Work directly in the provided working directory.",
    spec.isolation === "worktree" ? "- This is an isolated delegated git worktree. Do not commit, rebase, or manipulate other worktrees." : "- This job is using the shared workspace; avoid unrelated changes.",
    "- If a file scope is declared, do not modify files outside it.",
    "- Keep edits minimal and focused; do not perform unrelated refactors.",
    "- Run focused tests or checks when useful and affordable.",
    "- Do not commit, push, rebase, reset, or discard unrelated existing changes.",
    "- Return the requested structured summary when finished."
  ].join("\n");
}

function assertDisjointWriteScopes(specs, allowOverlap) {
  if (allowOverlap) return;
  const writable = specs.filter((spec) => spec.sandbox !== "read-only" && spec.isolation !== "worktree");
  if (writable.length < 2) return;
  for (const spec of writable) {
    if (!spec.files.length) {
      throw new Error("Parallel writable Codex tasks must declare files. Use sandbox=read-only, declare disjoint files, or set allow_overlap=true explicitly.");
    }
  }
  for (let left = 0; left < writable.length; left += 1) {
    for (let right = left + 1; right < writable.length; right += 1) {
      const overlap = overlappingPaths(writable[left].files, writable[right].files);
      if (overlap) {
        throw new Error(`Parallel Codex write scopes overlap at ${overlap}. Split the scopes or set allow_overlap=true explicitly.`);
      }
    }
  }
}

function overlappingPaths(left, right) {
  for (const a of left) {
    for (const b of right) {
      if (sameOrContains(a, b) || sameOrContains(b, a)) return shorter(a, b);
    }
  }
  return null;
}

function sameOrContains(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function shorter(left, right) {
  return left.length <= right.length ? left : right;
}

function publicJob(job, includeResult) {
  return {
    id: job.id,
    batch_id: job.batchId,
    name: job.name,
    task: job.task,
    status: job.status,
    cwd: job.spec.cwd,
    files: job.spec.files,
    sandbox: job.spec.sandbox,
    thread_id: job.threadId,
    created_at: job.createdAt,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    changed_files: [...job.changedFiles],
    isolation: job.spec.isolation,
    worktree: job.worktree ? publicWorktreeResult(job.worktree) : null,
    merge_result: job.mergeResult,
    isolation_error: job.isolationError,
    parent_task_id: job.spec.parentTaskId || null,
    parent_session_id: job.spec.parentSessionId || null,
    provider: job.activeProvider,
    provider_chain: job.providerChain,
    provider_attempts: job.providerAttempts.map((attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      status: attempt.status,
      category: attempt.category,
      error: attempt.error,
      started_at: attempt.started_at,
      finished_at: attempt.finished_at,
      thread_id: attempt.thread_id,
      usage: attempt.usage,
      warnings: attempt.warnings
    })),
    ...(includeResult ? {
      result: job.result,
      output: job.output,
      commands: job.commands,
      usage: job.usage,
      error: job.error
    } : job.error ? { error: job.error } : {})
  };
}

function parseStructuredResult(output, changedFiles) {
  const text = String(output || "").trim();
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        return {
          ...parsed,
          changed_files: dedupeStrings([...(parsed.changed_files || []), ...changedFiles])
        };
      }
    } catch {}
  }
  return {
    summary: text,
    changed_files: [...changedFiles],
    tests: [],
    blockers: [],
    risks: []
  };
}

function normalizePaths(values, cwd) {
  if (!Array.isArray(values)) return [];
  return dedupeStrings(values.map((value) => cleanString(value)).filter(Boolean).map((value) => path.resolve(cwd, value)));
}

function normalizeIds(values) {
  return dedupeStrings(Array.isArray(values) ? values.map((value) => cleanString(value)).filter(Boolean) : []);
}

function normalizeSandbox(value) {
  const sandbox = cleanString(value) || "danger-full-access";
  if (!["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) {
    throw new Error(`Unsupported Codex sandbox '${sandbox}'.`);
  }
  return sandbox;
}

function normalizeIsolation(value, sandbox) {
  const requested = cleanString(value);
  if (!requested) return sandbox === "read-only" ? "shared" : "worktree";
  if (!["shared", "worktree"].includes(requested)) throw new Error(`Unsupported agent isolation '${requested}'.`);
  if (sandbox === "read-only" && requested === "worktree") return "worktree";
  return requested;
}

function normalizeReasoning(value) {
  const effort = cleanString(value);
  if (!effort) return "";
  if (!["minimal", "low", "medium", "high", "xhigh"].includes(effort)) {
    throw new Error(`Unsupported Codex reasoning effort '${effort}'.`);
  }
  return effort;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function dedupeStrings(values) {
  return [...new Set(values.map(String))];
}

function appendLimited(current, next, max) {
  const separator = current && next ? "\n" : "";
  const combined = `${current}${separator}${next}`;
  return combined.length <= max ? combined : combined.slice(combined.length - max);
}

function isTerminal(status) {
  return ["completed", "failed", "cancelled"].includes(status);
}

function isNonFatalCodexWarning(message) {
  return /^Model metadata for `[^`]+` not found\. Defaulting to fallback metadata;/i.test(String(message || ""));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown Codex error");
}
