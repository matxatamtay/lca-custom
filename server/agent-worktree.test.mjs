// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  cleanupAgentWorktree,
  createAgentWorktree,
  finalizeAgentWorktree,
  mergeAgentWorktree
} from "./agent-worktree.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function repoFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-worktree-test-"));
  git(root, "init");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.txt"), "base\n", "utf8");
  await writeFile(path.join(root, "src", "b.txt"), "b\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  return root;
}

test("isolated worktree inherits dirty source state but emits only delegated delta", async () => {
  const root = await repoFixture();
  let state;
  try {
    await writeFile(path.join(root, "src", "a.txt"), "parent dirty\n", "utf8");
    await writeFile(path.join(root, "scratch.txt"), "untracked parent\n", "utf8");
    state = await createAgentWorktree({ cwd: root, jobId: "inherit", files: [path.join(root, "src", "a.txt")] });
    assert.equal(await readFile(path.join(state.worktreeRoot, "src", "a.txt"), "utf8"), "parent dirty\n");
    assert.equal(await readFile(path.join(state.worktreeRoot, "scratch.txt"), "utf8"), "untracked parent\n");

    await writeFile(path.join(state.worktreeRoot, "src", "a.txt"), "agent change\n", "utf8");
    const finalized = await finalizeAgentWorktree(state, [path.join(root, "src", "a.txt")]);
    assert.deepEqual(finalized.changed_files, ["src/a.txt"]);
    assert.deepEqual(finalized.scope_violations, []);

    const merged = await mergeAgentWorktree(state, { cleanup: false });
    assert.equal(merged.ok, true);
    assert.equal(await readFile(path.join(root, "src", "a.txt"), "utf8"), "agent change\n");
  } finally {
    if (state) await cleanupAgentWorktree(state).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("detects delegated writes outside declared scope and blocks merge", async () => {
  const root = await repoFixture();
  let state;
  try {
    state = await createAgentWorktree({ cwd: root, jobId: "scope", files: [path.join(root, "src", "a.txt")] });
    await writeFile(path.join(state.worktreeRoot, "src", "b.txt"), "unauthorized\n", "utf8");
    const finalized = await finalizeAgentWorktree(state, [path.join(root, "src", "a.txt")]);
    assert.deepEqual(finalized.scope_violations, ["src/b.txt"]);
    const merged = await mergeAgentWorktree(state, { cleanup: false });
    assert.equal(merged.ok, false);
    assert.equal(merged.reason, "scope_violation");
    assert.equal(await readFile(path.join(root, "src", "b.txt"), "utf8"), "b\n");
  } finally {
    if (state) await cleanupAgentWorktree(state).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("merge conflict check leaves source unchanged", async () => {
  const root = await repoFixture();
  let state;
  try {
    state = await createAgentWorktree({ cwd: root, jobId: "conflict", files: [path.join(root, "src", "a.txt")] });
    await writeFile(path.join(state.worktreeRoot, "src", "a.txt"), "agent\n", "utf8");
    await finalizeAgentWorktree(state, [path.join(root, "src", "a.txt")]);
    await writeFile(path.join(root, "src", "a.txt"), "parent after spawn\n", "utf8");

    const merged = await mergeAgentWorktree(state, { cleanup: false });
    assert.equal(merged.ok, false);
    assert.equal(merged.conflict, true);
    assert.equal(await readFile(path.join(root, "src", "a.txt"), "utf8"), "parent after spawn\n");
  } finally {
    if (state) await cleanupAgentWorktree(state).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
