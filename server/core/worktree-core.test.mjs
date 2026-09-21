import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createWorktreeCore } from "./worktree-core.mjs";

const execFileAsync = promisify(execFile);

async function spawnCapture(file, args, cwd, timeoutMs) {
  try {
    const result = await execFileAsync(file, args, { cwd, timeout: timeoutMs, maxBuffer: 2_000_000 });
    return { exit_code: 0, timed_out: false, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    return {
      exit_code: Number.isInteger(error.code) ? error.code : 1,
      timed_out: Boolean(error.killed),
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || ""
    };
  }
}

function parsePorcelain(out) {
  return String(out || "").split(/\r?\n/).filter(Boolean).map((line) => ({
    index: line[0] === " " ? null : line[0],
    worktree: line[1] === " " ? null : line[1],
    path: line.slice(3),
    staged: line[0] !== " " && line[0] !== "?",
    untracked: line.startsWith("??")
  }));
}

async function initRepo(parent, name) {
  const repo = path.join(parent, name);
  await mkdir(repo, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "lca@example.test"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "LCA Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), `# ${name}\n`, "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repo });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd: repo });
  return repo;
}

function core(baseDir, now) {
  return createWorktreeCore({
    WORKTREE_BASE_DIR: baseDir,
    spawnCapture,
    parsePorcelain,
    DEFAULT_CMD_TIMEOUT: 20_000,
    ...(now ? { now } : {})
  });
}

test("different repositories keep direct task execution targets", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lca-worktree-direct-"));
  const repoA = await initRepo(temp, "repo-a");
  const repoB = await initRepo(temp, "repo-b");
  const worktrees = core(path.join(temp, "managed"));
  const result = await worktrees.createTarget({ cwd: repoA, parallelWithCwd: repoB, taskId: "task-a" });
  assert.equal(result.created, false);
  assert.equal(result.target.isolated, false);
  assert.equal(result.target.root, await realpath(repoA));
  assert.equal(result.target.cwd, await realpath(repoA));
  await rm(temp, { recursive: true, force: true });
});

test("same repository gets an isolated worktree and cleanup refuses dirty state by default", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lca-worktree-isolated-"));
  const repo = await initRepo(temp, "repo");
  const worktrees = core(path.join(temp, "managed"));
  const created = await worktrees.createTarget({ cwd: repo, parallelWithCwd: repo, taskId: "parallel-1" });
  assert.equal(created.created, true);
  assert.equal(created.target.isolated, true);
  assert.equal(created.target.branch, "lca/parallel-1");
  assert.notEqual(created.target.cwd, repo);
  assert.equal(await readFile(path.join(created.target.cwd, "README.md"), "utf8"), "# repo\n");

  await writeFile(path.join(created.target.cwd, "README.md"), "# changed\n", "utf8");
  assert.equal(await readFile(path.join(repo, "README.md"), "utf8"), "# repo\n");

  const check = await worktrees.check({ cwd: repo, taskId: "parallel-1", against: "HEAD" });
  assert.equal(check.clean, false);
  assert.equal(check.merge_performed, false);
  assert.equal(check.changes.length, 1);

  await assert.rejects(
    worktrees.cleanup({ cwd: repo, taskId: "parallel-1" }),
    /Refusing to remove dirty worktree/
  );
  const removed = await worktrees.cleanup({ cwd: repo, taskId: "parallel-1", force: true, deleteBranch: true });
  assert.equal(removed.ok, true);
  assert.equal(removed.branch_deleted, true);
  await rm(temp, { recursive: true, force: true });
});

test("status and diff operate only on LCA-managed worktrees", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lca-worktree-status-"));
  const repo = await initRepo(temp, "repo");
  const worktrees = core(path.join(temp, "managed"));
  const created = await worktrees.createIsolated({ repoRoot: repo, taskId: "task-2" });
  await writeFile(path.join(created.target.cwd, "new.txt"), "hello\n", "utf8");
  const status = await worktrees.status({ cwd: repo, taskId: "task-2" });
  assert.equal(status.count, 1);
  assert.equal(status.worktrees[0].owned, true);
  assert.equal(status.worktrees[0].clean, false);
  const diff = await worktrees.diff({ cwd: repo, taskId: "task-2" });
  assert.equal(diff.empty, true, "untracked files are reported by status, not git diff");
  await worktrees.cleanup({ cwd: repo, taskId: "task-2", force: true, deleteBranch: true });
  await rm(temp, { recursive: true, force: true });
});

test("stale worktree GC removes clean LCA worktrees but protects dirty ones", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lca-worktree-gc-"));
  const repo = await initRepo(temp, "repo");
  const nowMs = Date.parse("2026-09-17T00:00:00Z");
  const worktrees = core(path.join(temp, "managed"), () => nowMs);
  const clean = await worktrees.createIsolated({ repoRoot: repo, taskId: "stale-clean" });
  const dirty = await worktrees.createIsolated({ repoRoot: repo, taskId: "stale-dirty" });
  const old = new Date(nowMs - 30 * 24 * 60 * 60_000);
  await writeFile(path.join(dirty.target.cwd, "README.md"), "# dirty\n", "utf8");
  await utimes(clean.target.cwd, old, old);
  await utimes(dirty.target.cwd, old, old);

  const result = await worktrees.gc({ cwd: repo, maxAgeMs: 7 * 24 * 60 * 60_000 });
  assert.equal(result.stale, 2);
  assert.equal(result.removed, 1);
  assert.equal(result.protected_dirty, 1);
  assert.ok(result.worktrees.some((item) => item.status === "removed" && item.path === clean.target.cwd));
  assert.ok(result.worktrees.some((item) => item.status === "protected_dirty" && item.path === dirty.target.cwd));
  const remaining = await worktrees.status({ cwd: repo });
  assert.equal(remaining.count, 1);
  assert.equal(remaining.worktrees[0].path, dirty.target.cwd);
  await worktrees.cleanup({ cwd: repo, taskId: "stale-dirty", force: true, deleteBranch: true });
  await rm(temp, { recursive: true, force: true });
});

test("worktree GC skips non-git roots without reporting an error", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lca-worktree-nongit-"));
  try {
    const worktrees = core(path.join(temp, "managed"));
    const result = await worktrees.gc({ cwd: temp });
    assert.equal(result.skipped_non_git, true);
    assert.equal(result.scanned, 0);
    assert.deepEqual(result.errors, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("branch and task identifiers are validated before git worktree creation", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lca-worktree-validation-"));
  const repo = await initRepo(temp, "repo");
  const worktrees = core(path.join(temp, "managed"));
  await assert.rejects(
    worktrees.createIsolated({ repoRoot: repo, taskId: "bad/task" }),
    /task_id/
  );
  await assert.rejects(
    worktrees.createIsolated({ repoRoot: repo, taskId: "safe", branch: "feature/not-lca" }),
    /must start with 'lca\/'/
  );
  await rm(temp, { recursive: true, force: true });
});
