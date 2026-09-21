import { access, readdir } from "node:fs/promises";
import path from "node:path";

export const PROJECT_MANIFESTS = new Set([
  "package.json", "tsconfig.json", "jsconfig.json", "pubspec.yaml", "pom.xml",
  "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
  "pyproject.toml", "requirements.txt", "go.mod", "cargo.toml"
]);

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".dart_tool", ".idea", ".vscode", "coverage", "runtime", "data"]);
const PREFERRED_DIRS = new Map([["server", 0], ["src", 1], ["app", 2], ["packages", 3], ["apps", 4], ["lib", 5]]);

export async function discoverProjectRoots(root, { maxDepth = 3, maxProjects = 40 } = {}) {
  const base = path.resolve(root);
  const projects = [];
  const seen = new Set();

  async function visit(dir, depth) {
    if (depth > maxDepth || projects.length >= maxProjects) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    const manifests = entries.filter((entry) => entry.isFile() && PROJECT_MANIFESTS.has(entry.name.toLowerCase())).map((entry) => entry.name);
    if (manifests.length) {
      const resolved = path.resolve(dir);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        projects.push({ root: resolved, manifests: manifests.sort(), depth });
      }
    }
    if (depth === maxDepth) return;
    const dirs = entries.filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name));
    dirs.sort((left, right) => directoryRank(left.name) - directoryRank(right.name) || left.name.localeCompare(right.name));
    for (const entry of dirs) await visit(path.join(dir, entry.name), depth + 1);
  }

  await visit(base, 0);
  return projects.sort((left, right) => projectRank(base, left.root) - projectRank(base, right.root) || left.root.localeCompare(right.root));
}

export async function resolveActiveProjectRoot({ workspaceRoot, requestedRoot, changedFiles = [], task = "" }) {
  const workspace = path.resolve(workspaceRoot || requestedRoot);
  const requested = path.resolve(requestedRoot || workspace);

  const changedRoots = [];
  for (const file of changedFiles || []) {
    const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(requested, file);
    const nearest = await findNearestProjectRoot(path.dirname(absolute), workspace);
    if (nearest) changedRoots.push(nearest);
  }
  const uniqueChanged = [...new Set(changedRoots)];
  if (uniqueChanged.length === 1) {
    return { root: uniqueChanged[0], reason: "changed_file", candidates: [{ root: uniqueChanged[0], manifests: await manifestsAt(uniqueChanged[0]), depth: relativeDepth(workspace, uniqueChanged[0]) }] };
  }

  const nearest = await findNearestProjectRoot(requested, workspace);
  if (nearest && nearest !== workspace) {
    return { root: nearest, reason: "nearest_ancestor", candidates: [{ root: nearest, manifests: await manifestsAt(nearest), depth: relativeDepth(workspace, nearest) }] };
  }

  const candidates = await discoverProjectRoots(requested);
  if (!candidates.length) return { root: requested, reason: "fallback", candidates: [] };
  const direct = candidates.find((candidate) => candidate.root === requested);
  if (direct) return { root: requested, reason: "direct_manifest", candidates };

  const taskLower = String(task).toLowerCase();
  const mentioned = candidates
    .map((candidate) => ({ candidate, score: taskProjectScore(requested, candidate.root, taskLower) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || projectRank(requested, left.candidate.root) - projectRank(requested, right.candidate.root));
  if (mentioned.length) return { root: mentioned[0].candidate.root, reason: "task_match", candidates };

  return { root: candidates[0].root, reason: "preferred_nested", candidates };
}

export async function findNearestProjectRoot(start, boundary) {
  const limit = path.resolve(boundary);
  let current = path.resolve(start);
  while (isWithin(current, limit)) {
    if ((await manifestsAt(current)).length) return current;
    if (samePath(current, limit)) break;
    const parent = path.dirname(current);
    if (samePath(parent, current)) break;
    current = parent;
  }
  return null;
}

async function manifestsAt(dir) {
  const found = [];
  for (const name of PROJECT_MANIFESTS) {
    try { await access(path.join(dir, name)); found.push(name); } catch { /* absent */ }
  }
  return found.sort();
}

function taskProjectScore(base, candidate, task) {
  const rel = path.relative(base, candidate).split(path.sep).join("/").toLowerCase();
  if (!rel || !task) return 0;
  let score = 0;
  for (const part of rel.split("/").filter(Boolean)) {
    if (part.length >= 3 && task.includes(part)) score += 10 + Math.min(10, part.length);
  }
  if (task.includes(rel)) score += 30;
  return score;
}

function projectRank(base, candidate) {
  const rel = path.relative(base, candidate).split(path.sep).join("/");
  if (!rel) return -1000;
  const first = rel.split("/")[0] || "";
  return (PREFERRED_DIRS.get(first) ?? 20) * 100 + relativeDepth(base, candidate);
}

function directoryRank(name) { return PREFERRED_DIRS.get(name) ?? 20; }
function relativeDepth(base, candidate) { const rel = path.relative(base, candidate); return rel ? rel.split(path.sep).length : 0; }
function samePath(a, b) { return normalize(a) === normalize(b); }
function isWithin(candidate, root) { const rel = path.relative(root, candidate); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); }
function normalize(value) { const resolved = path.resolve(value); return process.platform === "win32" ? resolved.toLowerCase() : resolved; }
