// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CodexDelegationManager } from "./codex-delegation.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
}

function warningThenSuccessCodex() {
  return {
    startThread() {
      return {
        async runStreamed() {
          async function* events() {
            yield { type: "thread.started", thread_id: "warning-thread" };
            yield {
              type: "item.completed",
              item: {
                type: "error",
                message: "Model metadata for `custom/model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."
              }
            };
            yield {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: JSON.stringify({ summary: "alive", changed_files: [], tests: [], blockers: [], risks: [] })
              }
            };
            yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
          }
          return { events: events() };
        }
      };
    }
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-codex-manager-"));
  git(root, "init");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "value.txt"), "base\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  return root;
}

function fakeCodex() {
  return {
    startThread(options) {
      return {
        async runStreamed() {
          await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "delegated\n", "utf8");
          async function* events() {
            yield { type: "thread.started", thread_id: "fake-thread" };
            yield {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: JSON.stringify({
                  summary: "changed value",
                  changed_files: ["src/value.txt"],
                  tests: ["fake test"],
                  blockers: [],
                  risks: []
                })
              }
            };
            yield { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } };
          }
          return { events: events() };
        }
      };
    }
  };
}

async function waitForJob(manager, id) {
  for (let i = 0; i < 100; i += 1) {
    const result = manager.collect({ job_ids: [id] });
    if (result.all_done) return result.jobs[0];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("delegated fake job did not finish");
}

test("treats custom model metadata fallback as a warning when the turn completes", async () => {
  const manager = new CodexDelegationManager({ createCodex: warningThenSuccessCodex });
  const started = manager.delegate({
    task: "smoke",
    cwd: process.cwd(),
    sandbox: "read-only",
    isolation: "shared"
  });
  const done = await waitForJob(manager, started.id);
  assert.equal(done.status, "completed");
  assert.equal(done.result.summary, "alive");
  assert.equal(done.error, null);
  assert.equal(done.provider_attempts[0].warnings.length, 1);
  assert.match(done.provider_attempts[0].warnings[0], /Defaulting to fallback metadata/);
});

test("falls back from exhausted provider, redacts secrets, and cools it down for later jobs", async () => {
  const calls = [];
  const providerConfig = {
    defaultChain: ["primary", "backup"],
    providers: new Map([
      ["codex", { name: "codex", type: "codex-default", baseUrl: "", apiKey: "", apiKeyEnv: "", keyConfigured: true, model: "", outputSchema: true }],
      ["primary", { name: "primary", type: "openai-compatible", baseUrl: "https://primary.example/v1", apiKey: "primary-secret", apiKeyEnv: "PRIMARY_KEY", keyConfigured: true, model: "model-primary", outputSchema: true }],
      ["backup", { name: "backup", type: "openai-compatible", baseUrl: "https://backup.example/v1", apiKey: "backup-secret", apiKeyEnv: "BACKUP_KEY", keyConfigured: true, model: "model-backup", outputSchema: false }]
    ])
  };
  const manager = new CodexDelegationManager({
    providerConfig,
    providerCooldowns: { billing: 60_000 },
    createCodex(provider) {
      calls.push(provider.name);
      return {
        startThread() {
          return {
            async runStreamed() {
              async function* events() {
                yield { type: "thread.started", thread_id: `thread-${provider.name}` };
                if (provider.name === "primary") {
                  yield { type: "turn.failed", error: { message: "insufficient_quota: primary-secret has no credits" } };
                  return;
                }
                yield { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ summary: "backup ok", changed_files: [], tests: [], blockers: [], risks: [] }) } };
                yield { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } };
              }
              return { events: events() };
            }
          };
        }
      };
    }
  });

  const first = manager.delegate({ task: "inspect", cwd: process.cwd(), sandbox: "read-only" });
  const done = await waitForJob(manager, first.id);
  assert.equal(done.status, "completed");
  assert.equal(done.provider, "backup");
  assert.deepEqual(done.provider_chain, ["primary", "backup"]);
  assert.equal(done.provider_attempts[0].category, "billing");
  assert.equal(done.provider_attempts[1].status, "completed");
  assert.equal(JSON.stringify(done).includes("primary-secret"), false);
  assert.equal(manager.providerStatus().providers.find((provider) => provider.name === "primary").cooldown_reason, "billing");

  const second = manager.delegate({ task: "inspect again", cwd: process.cwd(), sandbox: "read-only" });
  const secondDone = await waitForJob(manager, second.id);
  assert.equal(secondDone.provider, "backup");
  assert.deepEqual(calls, ["primary", "backup", "backup"]);
});

test("records a missing fallback key as its own configuration attempt", async () => {
  const providerConfig = {
    defaultChain: ["primary", "backup"],
    providers: new Map([
      ["codex", { name: "codex", type: "codex-default", baseUrl: "", apiKey: "", apiKeyEnv: "", keyConfigured: true, model: "", outputSchema: true }],
      ["primary", { name: "primary", type: "openai-compatible", baseUrl: "https://primary.example/v1", apiKey: "primary-secret", apiKeyEnv: "PRIMARY_KEY", keyConfigured: true, model: "model-primary", outputSchema: true }],
      ["backup", { name: "backup", type: "openai-compatible", baseUrl: "https://backup.example/v1", apiKey: "", apiKeyEnv: "BACKUP_KEY", keyConfigured: false, model: "model-backup", outputSchema: true }]
    ])
  };
  const manager = new CodexDelegationManager({
    providerConfig,
    createCodex(provider) {
      return {
        startThread() {
          return {
            async runStreamed() {
              async function* events() {
                if (provider.name === "primary") {
                  yield { type: "turn.failed", error: { message: "insufficient_quota: primary-secret depleted" } };
                }
              }
              return { events: events() };
            }
          };
        }
      };
    }
  });

  const started = manager.delegate({ task: "inspect", cwd: process.cwd(), sandbox: "read-only" });
  const done = await waitForJob(manager, started.id);
  assert.equal(done.status, "failed");
  assert.equal(done.provider_attempts.length, 2);
  assert.equal(done.provider_attempts[0].provider, "primary");
  assert.equal(done.provider_attempts[0].category, "billing");
  assert.equal(done.provider_attempts[1].provider, "backup");
  assert.equal(done.provider_attempts[1].category, "configuration");
  assert.equal(JSON.stringify(done).includes("primary-secret"), false);
});

test("Codex manager isolates writable jobs and merges only after explicit merge", async () => {
  const root = await fixture();
  const manager = new CodexDelegationManager({ createCodex: fakeCodex, maxParallel: 2 });
  let job;
  try {
    job = manager.delegate({
      task: "change value",
      cwd: root,
      files: [path.join(root, "src", "value.txt")],
      sandbox: "workspace-write"
    });
    assert.equal(job.isolation, "worktree");
    const done = await waitForJob(manager, job.id);
    assert.equal(done.status, "completed");
    assert.equal(done.worktree.merge_ready, true);
    assert.equal(await readFile(path.join(root, "src", "value.txt"), "utf8"), "base\n");

    const merged = await manager.merge({ job_id: job.id, cleanup: true });
    assert.equal(merged.ok, true);
    assert.equal(merged.applied, true);
    assert.equal(await readFile(path.join(root, "src", "value.txt"), "utf8"), "delegated\n");
  } finally {
    if (job) await manager.cleanup(job.id).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
