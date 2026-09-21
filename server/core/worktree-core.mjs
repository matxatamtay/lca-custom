import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  createTaskExecutionTarget,
  sameRepository,
  sanitizeTaskId
} from "./task-execution-target.mjs";

export function createWorktreeCore(options) {
  const {
    WORKTREE_BASE_DIR,
    spawnCapture,
    parsePorcelain,
    DEFAULT_CMD_TIMEOUT = 60_000,
    now = Date.now
  } = options;

  async function createTarget({ cwd, taskId, parallelWithCwd, baseRef = "HEAD", branch } = {}) {
    const safeTaskId = sanitizeTaskId(taskId);
    const repoRoot = await gitRoot(cwd);
    if (!parallelWithCwd) {
      return {
        created: false,
        reason: "parallel_with_cwd was not provided; direct repository root remains authoritative",
        target: createTaskExecutionTarget({ root: repoRoot, taskId: safeTaskId })
      };
    }
    const peerRoot = await gitRoot(parallelWithCwd);
    if (!sameRepository(repoRoot, peerRoot)) {
      return {
        created: false,
        reason: "parallel task targets a different repository; isolation is unnecessary",
        parallel_repo: peerRoot,
        target: createTaskExecutionTarget({ root: repoRoot, taskId: safeTaskId })
      };
    }
    return createIsolated({ repoRoot, taskId: safeTaskId, baseRef, branch });
  }

  async function createIsolated({ repoRoot, taskId, baseRef = "HEAD", branch } = {}) {
    const safeTaskId = sanitizeTaskId(taskId);
    const root = await gitRoot(repoRoot);
    const safeBranch = branch ? await validateBranch(root, branch) : `lca/${safeTaskId}`;
    if (!branch) await validateBranch(root, safeBranch);
    await validateBaseRef(root, baseRef);

    const worktree = worktreePath(root, safeTaskId);
    const existing = await findWorktree(root, worktree);
    if (existing) {
      return {
        created: false,
        reason: "worktree already exists",
        target: createTaskExecutionTarget({ root, taskId: safeTaskId, worktree, branch: existing.branch || safeBranch })
      };
    }
    if (existsSync(worktree)) {
      throw new Error(`Refusing to reuse non-worktree path: ${worktree}`);
    }

    await mkdir(path.dirname(worktree), { recursive: true });
    const branchExists = await gitOk(root, ["show-ref", "--verify", "--quiet", `refs/heads/${safeBranch}`]);
    const args = branchExists
      ? ["worktree", "add", worktree, safeBranch]
      : ["worktree", "add", "-b", safeBranch, worktree, baseRef];
    const result = await git(root, args);
    if (result.exit_code !== 0) {
      await rm(worktree, { recursive: true, force: true }).catch(() => {});
      throw new Error(firstError(result, "git worktree add failed"));
    }

    return {
      created: true,
      base_ref: baseRef,
      target: createTaskExecutionTarget({ root, taskId: safeTaskId, worktree, branch: safeBranch })
    };
  }

  async function status({ cwd, taskId } = {}) {
    const root = await gitRoot(cwd);
    const items = await listWorktrees(root);
    const filtered = taskId
      ? items.filter((item) => item.path === worktreePath(root, sanitizeTaskId(taskId)))
      : items.filter((item) => isOwnedWorktree(item.path));
    const worktrees = [];
    for (const item of filtered) {
      const state = await workingState(item.path);
      worktrees.push({ ...item, ...state, owned: isOwnedWorktree(item.path) });
    }
    return { root, count: worktrees.length, worktrees };
  }

  async function diff({ cwd, taskId, against } = {}) {
    const { root, worktree, task } = await resolveOwnedTaskWorktree(cwd, taskId);
    const [working, staged] = await Promise.all([
      git(worktree, ["diff"]),
      git(worktree, ["diff", "--staged"])
    ]);
    let branchDiff = null;
    if (against) {
      await validateBaseRef(root, against);
      const branch = await git(worktree, ["diff", `${against}...HEAD`]);
      branchDiff = branch.stdout || "";
    }
    return {
      root,
      task_id: task,
      worktree,
      against: against || null,
      working_diff: working.stdout || "",
      staged_diff: staged.stdout || "",
      branch_diff: branchDiff,
      empty: !(working.stdout || "").trim() && !(staged.stdout || "").trim() && !(branchDiff || "").trim()
    };
  }

  async function check({ cwd, taskId, against } = {}) {
    const { root, worktree, task } = await resolveOwnedTaskWorktree(cwd, taskId);
    const state = await workingState(worktree);
    const [unstagedCheck, stagedCheck] = await Promise.all([
      git(worktree, ["diff", "--check"]),
      git(worktree, ["diff", "--cached", "--check"])
    ]);
    let divergence = null;
    if (against) {
      await validateBaseRef(root, against);
      const counts = await git(worktree, ["rev-list", "--left-right", "--count", `${against}...HEAD`]);
      if (counts.exit_code === 0) {
        const [behind, ahead] = String(counts.stdout || "").trim().split(/\s+/).map((value) => Number(value || 0));
        divergence = { against, ahead, behind };
      }
    }
    const whitespaceOk = unstagedCheck.exit_code === 0 && stagedCheck.exit_code === 0;
    return {
      root,
      task_id: task,
      worktree,
      clean: state.clean,
      changes: state.files,
      whitespace_ok: whitespaceOk,
      whitespace_errors: [unstagedCheck.stdout, unstagedCheck.stderr, stagedCheck.stdout, stagedCheck.stderr]
        .filter(Boolean).join("\n").trim(),
      divergence,
      merge_performed: false
    };
  }

  async function gc({ cwd, maxAgeMs = 14 * 24 * 60 * 60_000, force = false, dryRun = false } = {}) {
    let root;
    try {
      root = await gitRoot(cwd);
    } catch (error) {
      if (/not a git repository/i.test(String(error?.message || error))) {
        return {
          root: path.resolve(cwd || "."),
          scanned: 0,
          stale: 0,
          removed: 0,
          protected_dirty: 0,
          skipped_recent: 0,
          skipped_non_git: true,
          errors: [],
          dry_run: Boolean(dryRun),
          worktrees: []
        };
      }
      throw error;
    }
    const items = (await listWorktrees(root)).filter((item) => isOwnedWorktree(item.path));
    const result = {
      root,
      skipped_non_git: false,
      scanned: items.length,
      stale: 0,
      removed: 0,
      protected_dirty: 0,
      skipped_recent: 0,
      errors: [],
      dry_run: Boolean(dryRun),
      worktrees: []
    };
    for (const item of items) {
      let info;
      try { info = await stat(item.path); }
      catch (error) {
        result.errors.push({ path: item.path, error: String(error?.message || error) });
        continue;
      }
      const ageMs = Math.max(0, now() - info.mtimeMs);
      if (ageMs < maxAgeMs) {
        result.skipped_recent += 1;
        result.worktrees.push({ path: item.path, branch: item.branch, age_ms: ageMs, status: "recent" });
        continue;
      }
      result.stale += 1;
      let state;
      try { state = await workingState(item.path); }
      catch (error) {
        result.errors.push({ path: item.path, error: String(error?.message || error) });
        continue;
      }
      if (!state.clean && !force) {
        result.protected_dirty += 1;
        result.worktrees.push({ path: item.path, branch: item.branch, age_ms: ageMs, status: "protected_dirty", changes: state.count });
        continue;
      }
      if (dryRun) {
        result.worktrees.push({ path: item.path, branch: item.branch, age_ms: ageMs, status: state.clean ? "stale_clean" : "stale_dirty_force_candidate", changes: state.count });
        continue;
      }
      const args = ["worktree", "remove"];
      if (!state.clean && force) args.push("--force");
      args.push(item.path);
      const removed = await git(root, args);
      if (removed.exit_code === 0) {
        result.removed += 1;
        result.worktrees.push({ path: item.path, branch: item.branch, age_ms: ageMs, status: "removed", branch_deleted: false });
      } else {
        result.errors.push({ path: item.path, error: firstError(removed, "git worktree remove failed") });
      }
    }
    return result;
  }

  async function cleanup({ cwd, taskId, force = false, deleteBranch = false } = {}) {
    const { root, worktree, task, item } = await resolveOwnedTaskWorktree(cwd, taskId);
    const state = await workingState(worktree);
    if (!state.clean && !force) {
      throw new Error(`Refusing to remove dirty worktree for task ${task}; pass force=true only after reviewing its changes.`);
    }
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(worktree);
    const removed = await git(root, args);
    if (removed.exit_code !== 0) throw new Error(firstError(removed, "git worktree remove failed"));

    let branchDeleted = false;
    let branchDeleteError = null;
    if (deleteBranch && item.branch) {
      const deleteArgs = ["branch", force ? "-D" : "-d", item.branch];
      const deletion = await git(root, deleteArgs);
      branchDeleted = deletion.exit_code === 0;
      if (!branchDeleted) branchDeleteError = firstError(deletion, "branch deletion failed");
    }
    return {
      ok: true,
      root,
      task_id: task,
      removed: worktree,
      branch: item.branch || null,
      branch_deleted: branchDeleted,
      ...(branchDeleteError ? { branch_delete_error: branchDeleteError } : {})
    };
  }

  async function resolveOwnedTaskWorktree(cwd, taskId) {
    const task = sanitizeTaskId(taskId);
    const root = await gitRoot(cwd);
    const worktree = worktreePath(root, task);
    if (!isOwnedWorktree(worktree)) throw new Error("Resolved worktree is outside the LCA-managed worktree directory");
    const item = await findWorktree(root, worktree);
    if (!item) throw new Error(`No LCA worktree found for task ${task}`);
    return { root, worktree, task, item };
  }

  async function gitRoot(cwd) {
    const working = path.resolve(cwd || ".");
    const result = await git(working, ["rev-parse", "--show-toplevel"]);
    if (result.exit_code !== 0) throw new Error(firstError(result, `Not a git repository: ${working}`));
    return path.resolve(String(result.stdout || "").trim());
  }

  async function validateBranch(root, branch) {
    const value = String(branch || "").trim();
    if (!value || value.length > 180) throw new Error("Invalid branch name");
    const result = await git(root, ["check-ref-format", "--branch", value]);
    if (result.exit_code !== 0) throw new Error(`Invalid branch name: ${value}`);
    if (!value.startsWith("lca/")) throw new Error("LCA-managed worktree branches must start with 'lca/'");
    return value;
  }

  async function validateBaseRef(root, ref) {
    const value = String(ref || "HEAD").trim();
    if (!value || /^-/.test(value)) throw new Error("Invalid base ref");
    const result = await git(root, ["rev-parse", "--verify", `${value}^{commit}`]);
    if (result.exit_code !== 0) throw new Error(`Base ref does not resolve to a commit: ${value}`);
    return value;
  }

  async function listWorktrees(root) {
    const result = await git(root, ["worktree", "list", "--porcelain"]);
    if (result.exit_code !== 0) throw new Error(firstError(result, "git worktree list failed"));
    const blocks = String(result.stdout || "").trim().split(/\n\s*\n/).filter(Boolean);
    return blocks.map(parseWorktreeBlock).filter(Boolean);
  }

  async function findWorktree(root, target) {
    const wanted = comparePath(target);
    return (await listWorktrees(root)).find((item) => comparePath(item.path) === wanted) || null;
  }

  async function workingState(worktree) {
    const result = await git(worktree, ["status", "--porcelain"]);
    if (result.exit_code !== 0) throw new Error(firstError(result, "git status failed"));
    const files = parsePorcelain(result.stdout || "");
    return { clean: files.length === 0, count: files.length, files };
  }

  async function git(cwd, args) {
    return spawnCapture("git", args, cwd, DEFAULT_CMD_TIMEOUT);
  }

  async function gitOk(cwd, args) {
    return (await git(cwd, args)).exit_code === 0;
  }

  function worktreePath(repoRoot, taskId) {
    const repoName = path.basename(repoRoot).replace(/[^A-Za-z0-9._-]+/g, "-") || "repo";
    const repoId = createHash("sha256").update(comparePath(repoRoot)).digest("hex").slice(0, 12);
    return path.join(canonicalPath(WORKTREE_BASE_DIR), `${repoName}-${repoId}`, sanitizeTaskId(taskId));
  }

  function isOwnedWorktree(candidate) {
    const base = canonicalPath(WORKTREE_BASE_DIR);
    const target = canonicalPath(candidate);
    const relative = path.relative(base, target);
    return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  return {
    createTarget,
    createIsolated,
    status,
    diff,
    check,
    cleanup,
    gc,
    worktreePath
  };
}

function parseWorktreeBlock(block) {
  const item = { path: null, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
  for (const line of String(block || "").split(/\r?\n/)) {
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ").trim();
    if (key === "worktree") item.path = path.resolve(value);
    else if (key === "HEAD") item.head = value || null;
    else if (key === "branch") item.branch = value.replace(/^refs\/heads\//, "") || null;
    else if (key === "detached") item.detached = true;
    else if (key === "bare") item.bare = true;
    else if (key === "locked") item.locked = value || true;
    else if (key === "prunable") item.prunable = value || true;
  }
  return item.path ? item : null;
}

function firstError(result, fallback) {
  return String(result?.stderr || result?.stdout || fallback).trim().split(/\r?\n/)[0] || fallback;
}

function comparePath(value) {
  const normalized = canonicalPath(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function canonicalPath(value) {
  const absolute = path.resolve(value);
  if (existsSync(absolute)) {
    try { return realpathSync.native(absolute); } catch { return absolute; }
  }
  const parent = path.dirname(absolute);
  if (parent === absolute) return absolute;
  const canonicalParent = canonicalPath(parent);
  return path.join(canonicalParent, path.basename(absolute));
}
