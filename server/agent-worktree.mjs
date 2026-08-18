// Local Coding Agent — isolated git worktrees for delegated agents
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_DIRTY_FILE_LIMIT = 5_000;
const DEFAULT_DIRTY_BYTES_LIMIT = 100 * 1024 * 1024;
const OUTPUT_LIMIT = 200_000;

export async function createAgentWorktree(input = {}) {
  const cwd = path.resolve(String(input.cwd || process.cwd()));
  const jobId = safeId(input.jobId || `job-${Date.now()}`);
  const sourceRoot = await gitRoot(cwd);
  const cwdRelative = safeRelative(sourceRoot, cwd, "Agent cwd");
  const sourceHead = (await git(sourceRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const parent = path.resolve(input.parentDir || path.join(os.tmpdir(), "lca-agent-worktrees", repoKey(sourceRoot)));
  const worktreeRoot = path.join(parent, jobId);
  const patchDir = path.resolve(input.patchDir || path.join(os.tmpdir(), "lca-agent-patches", repoKey(sourceRoot)));
  await mkdir(parent, { recursive: true });
  await mkdir(patchDir, { recursive: true });
  await rm(worktreeRoot, { recursive: true, force: true }).catch(() => undefined);

  await git(sourceRoot, ["worktree", "add", "--detach", "--force", worktreeRoot, sourceHead]);
  let baselineCommit = sourceHead;
  try {
    if (input.inheritDirty !== false) {
      await inheritWorkingTreeState(sourceRoot, worktreeRoot, {
        fileLimit: positiveInt(input.dirtyFileLimit, DEFAULT_DIRTY_FILE_LIMIT),
        bytesLimit: positiveInt(input.dirtyBytesLimit, DEFAULT_DIRTY_BYTES_LIMIT)
      });
      await git(worktreeRoot, ["add", "-A"]);
      await git(worktreeRoot, [
        "-c", "user.name=Local Coding Agent",
        "-c", "user.email=lca@localhost",
        "-c", "commit.gpgSign=false",
        "commit", "--allow-empty", "--no-gpg-sign", "-m", `LCA delegated baseline ${jobId}`
      ]);
      baselineCommit = (await git(worktreeRoot, ["rev-parse", "HEAD"])).stdout.trim();
    }
    const mappedCwd = path.join(worktreeRoot, cwdRelative);
    const mappedFiles = mapPathsIntoWorktree(input.files || [], sourceRoot, worktreeRoot);
    const mappedAdditionalDirectories = mapAdditionalDirectories(input.additionalDirectories || [], sourceRoot, worktreeRoot);
    return {
      jobId,
      sourceRoot,
      sourceHead,
      baselineCommit,
      worktreeRoot,
      cwd: mappedCwd,
      files: mappedFiles,
      additionalDirectories: mappedAdditionalDirectories,
      patchPath: path.join(patchDir, `${jobId}.patch`),
      inheritDirty: input.inheritDirty !== false,
      cleaned: false,
      finalized: false
    };
  } catch (error) {
    await removeWorktree(sourceRoot, worktreeRoot).catch(() => undefined);
    throw error;
  }
}

export async function finalizeAgentWorktree(state, declaredSourcePaths = []) {
  if (!state?.worktreeRoot) throw new Error("Missing delegated worktree state.");
  await assertExists(state.worktreeRoot, "Delegated worktree");
  await git(state.worktreeRoot, ["add", "-A"]);
  const names = await git(state.worktreeRoot, ["diff", "--cached", "--name-only", "-z", state.baselineCommit]);
  const changedRelative = splitNull(names.stdout).map(normalizeRelativePath);
  const patch = await git(state.worktreeRoot, ["diff", "--cached", "--binary", "--full-index", state.baselineCommit, "--"]);
  await writeFile(state.patchPath, patch.stdout, "utf8");
  const declaredRelative = normalizeDeclaredScope(declaredSourcePaths, state.sourceRoot);
  const violations = declaredRelative.length
    ? changedRelative.filter((file) => !declaredRelative.some((scope) => sameOrContains(scope, file)))
    : [];
  state.finalized = true;
  state.changedRelative = changedRelative;
  state.changedSourcePaths = changedRelative.map((file) => path.join(state.sourceRoot, file));
  state.scopeViolations = violations;
  state.patchBytes = Buffer.byteLength(patch.stdout);
  return publicWorktreeResult(state);
}

export async function mergeAgentWorktree(state, options = {}) {
  if (!state?.finalized) throw new Error("Finalize delegated worktree before merge.");
  if (state.scopeViolations?.length) {
    return {
      ok: false,
      applied: false,
      conflict: false,
      reason: "scope_violation",
      scope_violations: [...state.scopeViolations],
      changed_files: [...(state.changedRelative || [])]
    };
  }
  const targetRoot = await gitRoot(path.resolve(options.targetCwd || state.sourceRoot));
  if (path.resolve(targetRoot) !== path.resolve(state.sourceRoot)) {
    throw new Error(`Merge target is a different git repository: ${targetRoot}`);
  }
  const patch = await readFile(state.patchPath, "utf8");
  if (!patch.trim()) {
    if (options.cleanup !== false) await cleanupAgentWorktree(state);
    return { ok: true, applied: false, conflict: false, reason: "no_changes", changed_files: [] };
  }
  const check = await gitTry(targetRoot, ["apply", "--check", "--binary", "--whitespace=nowarn", state.patchPath]);
  if (!check.ok) {
    return {
      ok: false,
      applied: false,
      conflict: true,
      reason: "patch_conflict",
      changed_files: [...(state.changedRelative || [])],
      error: compactOutput(check.stderr || check.stdout)
    };
  }
  await git(targetRoot, ["apply", "--binary", "--whitespace=nowarn", state.patchPath]);
  if (options.cleanup !== false) await cleanupAgentWorktree(state);
  return {
    ok: true,
    applied: true,
    conflict: false,
    changed_files: [...(state.changedRelative || [])],
    patch_bytes: state.patchBytes || Buffer.byteLength(patch)
  };
}

export async function cleanupAgentWorktree(state) {
  if (!state?.worktreeRoot || state.cleaned) return { ok: true, cleaned: Boolean(state?.cleaned) };
  await removeWorktree(state.sourceRoot, state.worktreeRoot);
  await rm(state.patchPath, { force: true }).catch(() => undefined);
  state.cleaned = true;
  return { ok: true, cleaned: true, worktree: state.worktreeRoot };
}

export function publicWorktreeResult(state) {
  return {
    source_root: state.sourceRoot,
    source_head: state.sourceHead,
    baseline_commit: state.baselineCommit,
    worktree: state.worktreeRoot,
    patch_path: state.patchPath,
    patch_bytes: state.patchBytes || 0,
    changed_files: [...(state.changedRelative || [])],
    scope_violations: [...(state.scopeViolations || [])],
    inherit_dirty: Boolean(state.inheritDirty),
    finalized: Boolean(state.finalized),
    cleaned: Boolean(state.cleaned),
    merge_ready: Boolean(state.finalized && !(state.scopeViolations?.length))
  };
}

async function inheritWorkingTreeState(sourceRoot, worktreeRoot, limits) {
  const trackedPatch = await git(sourceRoot, ["diff", "HEAD", "--binary", "--full-index", "--"]);
  if (trackedPatch.stdout.trim()) {
    const tempPatch = path.join(os.tmpdir(), `lca-inherit-${process.pid}-${Date.now()}.patch`);
    try {
      await writeFile(tempPatch, trackedPatch.stdout, "utf8");
      await git(worktreeRoot, ["apply", "--binary", "--whitespace=nowarn", tempPatch]);
    } finally {
      await rm(tempPatch, { force: true }).catch(() => undefined);
    }
  }
  const untracked = splitNull((await git(sourceRoot, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout);
  if (untracked.length > limits.fileLimit) {
    throw new Error(`Refusing to inherit ${untracked.length} untracked files; limit is ${limits.fileLimit}.`);
  }
  let totalBytes = 0;
  for (const relative of untracked) {
    const source = path.join(sourceRoot, relative);
    const target = path.join(worktreeRoot, relative);
    const info = await lstat(source);
    if (info.isDirectory()) continue;
    totalBytes += info.size;
    if (totalBytes > limits.bytesLimit) {
      throw new Error(`Untracked files exceed delegated inheritance limit of ${limits.bytesLimit} bytes.`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    if (info.isSymbolicLink()) {
      const link = await readlink(source);
      await symlink(link, target).catch(async () => {
        await rm(target, { force: true });
        await symlink(link, target);
      });
    } else if (info.isFile()) {
      await copyFile(source, target);
    }
  }
}

function mapPathsIntoWorktree(values, sourceRoot, worktreeRoot) {
  return [...new Set(values.map((value) => {
    const absolute = path.resolve(String(value));
    const relative = safeRelative(sourceRoot, absolute, "Declared agent file scope");
    return path.join(worktreeRoot, relative);
  }))];
}

function mapAdditionalDirectories(values, sourceRoot, worktreeRoot) {
  return [...new Set(values.map((value) => {
    const absolute = path.resolve(String(value));
    const relative = path.relative(sourceRoot, absolute);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) return path.join(worktreeRoot, relative);
    return absolute;
  }))];
}

function normalizeDeclaredScope(values, sourceRoot) {
  return [...new Set(values.map((value) => normalizeRelativePath(safeRelative(sourceRoot, path.resolve(String(value)), "Declared agent file scope"))))];
}

async function gitRoot(cwd) {
  const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const root = result.stdout.trim();
  if (!root) throw new Error(`No git repository found for delegated worktree cwd ${cwd}.`);
  return path.resolve(root);
}

async function removeWorktree(sourceRoot, worktreeRoot) {
  const result = await gitTry(sourceRoot, ["worktree", "remove", "--force", worktreeRoot]);
  if (!result.ok) await rm(worktreeRoot, { recursive: true, force: true });
  await gitTry(sourceRoot, ["worktree", "prune"]);
}

async function git(cwd, args, timeoutMs = 60_000) {
  const result = await run("git", args, cwd, timeoutMs);
  if (result.exitCode !== 0) throw new Error(compactOutput(result.stderr || result.stdout || `git ${args.join(" ")} failed.`));
  return { stdout: result.stdout, stderr: result.stderr };
}

async function gitTry(cwd, args, timeoutMs = 60_000) {
  const result = await run("git", args, cwd, timeoutMs);
  return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
}

function run(command, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => { stdout = appendLimited(stdout, chunk.toString(), OUTPUT_LIMIT); });
    child.stderr.on("data", (chunk) => { stderr = appendLimited(stderr, chunk.toString(), OUTPUT_LIMIT); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: Number.isInteger(code) ? code : signal ? 124 : 1, stdout, stderr });
    });
  });
}

function safeRelative(root, candidate, label) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "") return "";
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} is outside git root: ${candidate}`);
  return relative;
}

function sameOrContains(scope, candidate) {
  const normalizedScope = normalizeRelativePath(scope).replace(/\/$/, "");
  const normalizedCandidate = normalizeRelativePath(candidate);
  return normalizedScope === "" || normalizedCandidate === normalizedScope || normalizedCandidate.startsWith(`${normalizedScope}/`);
}

function normalizeRelativePath(value) {
  return String(value || "").split(path.sep).join("/").replace(/^\.\//, "");
}

function splitNull(value) {
  return String(value || "").split("\0").filter(Boolean);
}

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100) || "job";
}

function repoKey(root) {
  return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function compactOutput(value) {
  return String(value || "").trim().slice(-8_000);
}

function appendLimited(current, next, max) {
  const combined = `${current}${next}`;
  return combined.length <= max ? combined : combined.slice(combined.length - max);
}

async function assertExists(target, label) {
  try { await access(target, fsConstants.F_OK); }
  catch { throw new Error(`${label} is unavailable: ${target}`); }
}
