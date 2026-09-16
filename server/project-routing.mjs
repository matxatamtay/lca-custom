import path from "node:path";

const GENERIC_PROJECT_TOKENS = new Set([
  "admin",
  "api",
  "app",
  "backend",
  "client",
  "custom",
  "frontend",
  "mobile",
  "project",
  "repo",
  "server",
  "service",
  "src",
  "web"
]);

export function resolveTaskProjectRoot(task, roots, primaryRoot = roots?.[0]) {
  const normalizedRoots = uniqueRoots(roots);
  const fallback = path.resolve(primaryRoot || normalizedRoots[0] || process.cwd());
  if (!normalizedRoots.length || !String(task || "").trim()) return fallback;

  const aliasesByRoot = projectAliases(normalizedRoots);
  const normalizedTask = normalizeText(task);
  const matchedRoots = normalizedRoots.filter((root) =>
    aliasesByRoot.get(comparePath(root))?.some((alias) => containsAlias(normalizedTask, alias))
  );

  return matchedRoots.length === 1 ? matchedRoots[0] : fallback;
}

export function projectAliases(roots) {
  const normalizedRoots = uniqueRoots(roots);
  const basenameCounts = countByRoot(normalizedRoots, (root) => normalizeText(path.basename(root)));
  const tokenCounts = new Map();
  const tokensByRoot = new Map();

  for (const root of normalizedRoots) {
    const tokens = new Set(projectNameTokens(path.basename(root)));
    tokensByRoot.set(comparePath(root), tokens);
    for (const token of tokens) tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
  }

  const labels = uniqueSuffixLabels(normalizedRoots);
  const result = new Map();
  for (const root of normalizedRoots) {
    const key = comparePath(root);
    const basename = normalizeText(path.basename(root));
    const aliases = new Set([
      normalizeText(root),
      normalizeText(labels.get(key) || "")
    ]);

    if (basename && basenameCounts.get(basename) === 1) aliases.add(basename);
    for (const token of tokensByRoot.get(key) || []) {
      if (tokenCounts.get(token) === 1 && !GENERIC_PROJECT_TOKENS.has(token)) aliases.add(token);
    }
    result.set(key, [...aliases].filter(Boolean));
  }
  return result;
}

function projectNameTokens(value) {
  return normalizeText(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function uniqueSuffixLabels(roots) {
  const parts = roots.map((root) => path.resolve(root).split(path.sep).filter(Boolean));
  const labels = new Map();
  roots.forEach((root, index) => {
    let depth = 1;
    let label = parts[index].slice(-depth).join("/") || root;
    while (depth < parts[index].length) {
      const collisions = parts.filter((segments) => normalizeText(segments.slice(-depth).join("/")) === normalizeText(label)).length;
      if (collisions === 1) break;
      depth++;
      label = parts[index].slice(-depth).join("/") || root;
    }
    labels.set(comparePath(root), label);
  });
  return labels;
}

function countByRoot(roots, selector) {
  const counts = new Map();
  for (const root of roots) {
    const value = selector(root);
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

function uniqueRoots(roots) {
  const seen = new Set();
  const result = [];
  for (const root of Array.isArray(roots) ? roots : []) {
    if (!root) continue;
    const resolved = path.resolve(root);
    const key = comparePath(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function containsAlias(normalizedTask, alias) {
  if (!alias) return false;
  let start = normalizedTask.indexOf(alias);
  while (start >= 0) {
    const before = start > 0 ? normalizedTask[start - 1] : "";
    const afterIndex = start + alias.length;
    const after = afterIndex < normalizedTask.length ? normalizedTask[afterIndex] : "";
    if (!isAlphaNumeric(before) && !isAlphaNumeric(after)) return true;
    start = normalizedTask.indexOf(alias, start + 1);
  }
  return false;
}

function isAlphaNumeric(value) {
  return Boolean(value && /[a-z0-9]/.test(value));
}

function normalizeText(value) {
  return String(value || "").replaceAll("\\", "/").toLowerCase();
}

function comparePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
