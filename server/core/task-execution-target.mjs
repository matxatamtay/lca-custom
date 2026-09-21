import path from "node:path";

export function createTaskExecutionTarget({ root, taskId, worktree = null, branch = null }) {
  const normalizedRoot = path.resolve(root);
  const normalizedWorktree = worktree ? path.resolve(worktree) : null;
  return Object.freeze({
    root: normalizedRoot,
    worktree: normalizedWorktree,
    branch: branch || null,
    taskId: String(taskId || "").trim(),
    isolated: Boolean(normalizedWorktree),
    cwd: normalizedWorktree || normalizedRoot
  });
}

export function sameRepository(left, right) {
  return comparePath(left) === comparePath(right);
}

export function sanitizeTaskId(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("task_id is required");
  if (raw.length > 80) throw new Error("task_id must be at most 80 characters");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw)) {
    throw new Error("task_id may contain only letters, numbers, dot, underscore, and hyphen");
  }
  if (raw === "." || raw === "..") throw new Error("invalid task_id");
  return raw;
}

function comparePath(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
