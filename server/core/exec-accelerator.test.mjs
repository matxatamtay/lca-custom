import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  createExecAccelerator,
  isReusableDeterministicCommand,
  isSetupCommand,
  runCommandDag,
  workspaceRevisionToken
} from "./exec-accelerator.mjs";

const execFileAsync = promisify(execFile);

test("only analysis-only deterministic commands are eligible for persistent reuse", () => {
  assert.equal(isReusableDeterministicCommand("npm run typecheck"), true);
  assert.equal(isReusableDeterministicCommand("npx tsc --noEmit"), true);
  assert.equal(isReusableDeterministicCommand("flutter analyze"), true);
  assert.equal(isReusableDeterministicCommand("npm test"), false);
  assert.equal(isReusableDeterministicCommand("npm run lint"), false);
  assert.equal(isReusableDeterministicCommand("npm run typecheck && rm -rf build"), false);
  assert.equal(isSetupCommand("flutter pub get"), true);
  assert.equal(isSetupCommand("npm ci"), true);
  assert.equal(isSetupCommand("npm test"), false);
});

test("deterministic success reuse is revision-scoped while arbitrary commands always execute", async () => {
  let runs = 0;
  let revision = "rev-a";
  const accelerator = createExecAccelerator({
    runShellCommand: async (command) => {
      runs += 1;
      return { exit_code: 0, timed_out: false, stdout: `run:${runs}:${command}`, stderr: "" };
    },
    revisionToken: async () => ({ repo_root: "/repo", token: revision, dirty_files: 1 }),
    revisionTtlMs: 0
  });

  const first = await accelerator.run("npm run typecheck", "/repo", "bash", 10_000);
  const second = await accelerator.run("npm run typecheck", "/repo", "bash", 10_000);
  assert.equal(runs, 1);
  assert.equal(first.acceleration.cache_hit, false);
  assert.equal(second.acceleration.cache_hit, true);

  revision = "rev-b";
  const third = await accelerator.run("npm run typecheck", "/repo", "bash", 10_000);
  assert.equal(runs, 2);
  assert.equal(third.acceleration.cache_hit, false);

  await accelerator.run("npm test", "/repo", "bash", 10_000);
  await accelerator.run("npm test", "/repo", "bash", 10_000);
  assert.equal(runs, 4);
});

test("identical setup commands only dedupe while concurrently in flight", async () => {
  let runs = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const accelerator = createExecAccelerator({
    runShellCommand: async () => {
      runs += 1;
      await barrier;
      return { exit_code: 0, timed_out: false, stdout: "ok", stderr: "" };
    },
    revisionToken: async () => null
  });

  const firstPromise = accelerator.run("flutter pub get", "/repo", "bash", 10_000);
  const secondPromise = accelerator.run("flutter pub get", "/repo", "bash", 10_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 1);
  release();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(first.acceleration.mode, "setup_dedupe");
  assert.equal(second.acceleration.in_flight_join, true);

  await accelerator.run("flutter pub get", "/repo", "bash", 10_000);
  assert.equal(runs, 2, "setup command must execute again after the prior call completes");
});

test("command DAG runs independent roots concurrently and waits for dependencies", async () => {
  const started = [];
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const nodes = [
    { id: "typecheck", depends_on: [] },
    { id: "analyze", depends_on: [] },
    { id: "summary", depends_on: ["typecheck", "analyze"] }
  ];
  const pending = runCommandDag(nodes, async (node) => {
    started.push(node.id);
    if (node.id !== "summary") await barrier;
    return { id: node.id, exit_code: 0, timed_out: false };
  }, { maxConcurrency: 2 });

  for (let index = 0; index < 20 && started.length < 2; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.deepEqual(new Set(started), new Set(["typecheck", "analyze"]));
  release();
  const results = await pending;
  assert.equal(started[2], "summary");
  assert.equal(results.every((entry) => entry.exit_code === 0), true);
});

test("command DAG skips dependent nodes after a dependency failure", async () => {
  const nodes = [
    { id: "a", depends_on: [] },
    { id: "b", depends_on: ["a"] }
  ];
  const results = await runCommandDag(nodes, async (node) => ({ id: node.id, exit_code: node.id === "a" ? 1 : 0, timed_out: false }));
  assert.equal(results[0].exit_code, 1);
  assert.equal(results[1].skipped, true);
  assert.equal(results[1].skip_reason, "dependency_failed");
});

test("workspace revision token changes when dirty tracked or untracked content changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-exec-revision-"));
  try {
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "lca@example.invalid"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "LCA Test"], { cwd: root });
    await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    await execFileAsync("git", ["add", "a.ts"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
    const clean = await workspaceRevisionToken(root);
    await writeFile(path.join(root, "a.ts"), "export const a = 2;\n");
    const dirty = await workspaceRevisionToken(root);
    await writeFile(path.join(root, "new.ts"), "export const n = 1;\n");
    const untracked = await workspaceRevisionToken(root);
    assert.ok(clean?.token);
    assert.notEqual(clean.token, dirty.token);
    assert.notEqual(dirty.token, untracked.token);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
