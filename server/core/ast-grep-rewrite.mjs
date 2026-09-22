import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { hashBytes } from "./file-state.mjs";
import { inferPatternNodeKind, runAstGrepProcess } from "./ast-grep-search.mjs";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_PREVIEW_TEXT_CHARS = 4_000;

export function createAstGrepRewritePlanner({
  binary = null,
  toRel = (value) => value,
  runProcess = runAstGrepProcess,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  async function plan({ pattern, rewrite, lang, paths, maxMatches } = {}) {
    const limit = Math.max(1, Math.min(500, Number(maxMatches) || 0));
    if (!binary) return unavailablePlan({ pattern, rewrite, lang, paths, limit });
    if (!Array.isArray(paths) || paths.length === 0) {
      return failedPlan("paths_required", "At least one explicit rewrite path is required.", { pattern, rewrite, lang, limit });
    }
    if (!Number.isFinite(Number(maxMatches)) || Number(maxMatches) < 1) {
      return failedPlan("max_matches_required", "max_matches must be an explicit positive integer.", { pattern, rewrite, lang, limit });
    }

    let scopes;
    try {
      scopes = await normalizeScopes(paths);
    } catch (error) {
      return failedPlan("invalid_scope", String(error?.message || error), { pattern, rewrite, lang, limit });
    }

    const rawMatches = [];
    const seen = new Set();
    let durationMs = 0;
    for (const scope of scopes) {
      const remaining = Math.max(0, limit - rawMatches.length);
      const processLimit = Math.max(1, remaining + 1);
      const args = buildAstGrepRewriteArgs({
        pattern,
        rewrite,
        lang,
        target: scope.target
      });
      const result = await runProcess({
        binary,
        args,
        cwd: scope.cwd,
        limit: processLimit,
        timeoutMs
      });
      durationMs += Number(result.duration_ms || 0);

      const noMatches = result.exit_code === 1 && (result.matches || []).length === 0;
      const failed = result.exit_code !== 0 && !noMatches && !result.stopped_early;
      if (failed) {
        return failedPlan(
          "ast_grep_failed",
          cleanError(result.stderr || `ast-grep exited with code ${result.exit_code}`),
          { pattern, rewrite, lang, limit, scopes }
        );
      }

      const nodeKind = inferPatternNodeKind(result.stderr);
      for (const raw of result.matches || []) {
        const match = normalizeRewriteMatch(raw, { cwd: scope.cwd, toRel, nodeKind });
        if (!scopeContains(scope, match.absolute_path)) {
          return failedPlan(
            "scope_violation",
            `ast-grep returned a match outside the requested scope: ${match.path}`,
            { pattern, rewrite, lang, limit, scopes }
          );
        }
        const key = [match.absolute_path, match.offsets.start, match.offsets.end, match.replacement].join("\0");
        if (seen.has(key)) continue;
        seen.add(key);
        rawMatches.push(match);
        if (rawMatches.length > limit) {
          return {
            ...basePlan({ pattern, rewrite, lang, limit, scopes }),
            ok: false,
            reason: "match_limit_exceeded",
            error: `Structural rewrite matched more than max_matches=${limit}; no files were changed.`,
            count: rawMatches.length,
            overflow: true,
            matches: rawMatches.slice(0, limit).map(publicMatch)
          };
        }
      }
    }

    const grouped = groupMatches(rawMatches);
    const files = [];
    try {
      for (const [absolutePath, matches] of grouped) {
        const raw = await readFile(absolutePath);
        validateRewriteMatches(raw, matches, toRel(absolutePath));
        files.push({
          absolute_path: absolutePath,
          path: toRel(absolutePath),
          sha256: hashBytes(raw),
          bytes_before: raw.length,
          matches
        });
      }
    } catch (error) {
      return failedPlan(
        "stale_or_invalid_match",
        String(error?.message || error),
        { pattern, rewrite, lang, limit, scopes }
      );
    }

    return {
      ...basePlan({ pattern, rewrite, lang, limit, scopes }),
      ok: true,
      duration_ms: round(durationMs),
      count: rawMatches.length,
      files,
      matches: rawMatches.map(publicMatch)
    };
  }

  return { plan };
}

export function buildAstGrepRewriteArgs({ pattern, rewrite, lang, target = "." } = {}) {
  return [
    "run",
    "--pattern", String(pattern || ""),
    "--rewrite", String(rewrite ?? ""),
    "--lang", String(lang || ""),
    "--debug-query=ast",
    "--json=stream",
    "--color", "never",
    target
  ];
}

export function normalizeRewriteMatch(raw, { cwd = ".", toRel = (value) => value, nodeKind = null } = {}) {
  const absolutePath = path.isAbsolute(raw?.file || "")
    ? path.resolve(raw.file)
    : path.resolve(cwd, raw?.file || "");
  const start = Number(raw?.replacementOffsets?.start ?? raw?.range?.byteOffset?.start);
  const end = Number(raw?.replacementOffsets?.end ?? raw?.range?.byteOffset?.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new Error(`Invalid ast-grep replacement offsets for ${toRel(absolutePath)}.`);
  }
  if (typeof raw?.replacement !== "string") {
    throw new Error(`ast-grep did not return replacement text for ${toRel(absolutePath)}.`);
  }
  const text = String(raw?.text || "");
  const replacement = String(raw.replacement);
  return {
    absolute_path: absolutePath,
    path: toRel(absolutePath),
    line: Number(raw?.range?.start?.line || 0) + 1,
    range: normalizeRange(raw?.range),
    offsets: { start, end },
    node_kind: nodeKind || null,
    text,
    replacement,
    captures: normalizeCaptures(raw?.metaVariables)
  };
}

export function applyAstRewritePlanToBuffer(raw, matches, label = "file") {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || "");
  validateRewriteMatches(buffer, matches, label);
  let output = buffer;
  const descending = [...matches].sort((left, right) => right.offsets.start - left.offsets.start);
  for (const match of descending) {
    output = Buffer.concat([
      output.subarray(0, match.offsets.start),
      Buffer.from(match.replacement, "utf8"),
      output.subarray(match.offsets.end)
    ]);
  }
  return output;
}

export function validateRewriteMatches(raw, matches, label = "file") {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || "");
  const ordered = [...(matches || [])].sort((left, right) => left.offsets.start - right.offsets.start);
  let previousEnd = -1;
  for (const match of ordered) {
    const { start, end } = match.offsets || {};
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > buffer.length) {
      throw new Error(`Invalid structural rewrite range in ${label}: ${start}..${end}.`);
    }
    if (start < previousEnd) throw new Error(`Overlapping structural rewrite matches in ${label}.`);
    const expected = Buffer.from(String(match.text || ""), "utf8");
    const actual = buffer.subarray(start, end);
    if (!actual.equals(expected)) {
      throw new Error(`STALE_AST_MATCH: ${label} changed after ast-grep preview at bytes ${start}..${end}.`);
    }
    previousEnd = end;
  }
  return true;
}

function basePlan({ pattern, rewrite, lang, limit, scopes }) {
  return {
    engine: "ast-grep",
    available: true,
    pattern,
    rewrite,
    lang,
    max_matches: limit,
    scopes: (scopes || []).map((scope) => ({
      path: scope.display,
      kind: scope.kind
    }))
  };
}

function unavailablePlan({ pattern, rewrite, lang, paths, limit }) {
  return {
    engine: "ast-grep",
    available: false,
    ok: false,
    reason: "ast_grep_unavailable",
    error: "ast-grep CLI unavailable",
    pattern,
    rewrite,
    lang,
    max_matches: limit,
    scopes: (paths || []).map((value) => ({ path: String(value), kind: "unknown" })),
    count: 0,
    matches: []
  };
}

function failedPlan(reason, error, options) {
  return {
    ...basePlan(options),
    ok: false,
    reason,
    error,
    count: 0,
    matches: []
  };
}

async function normalizeScopes(paths) {
  const unique = [...new Set(paths.map((value) => path.resolve(value)))];
  const inspected = [];
  for (const absolute of unique) {
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new Error(`Rewrite scope does not exist: ${absolute}`);
    if (!info.isDirectory() && !info.isFile()) throw new Error(`Rewrite scope is not a file or directory: ${absolute}`);
    inspected.push({
      absolute,
      kind: info.isDirectory() ? "directory" : "file",
      cwd: info.isDirectory() ? absolute : path.dirname(absolute),
      target: info.isDirectory() ? "." : path.basename(absolute),
      display: absolute
    });
  }

  inspected.sort((left, right) => left.absolute.length - right.absolute.length || left.absolute.localeCompare(right.absolute));
  const minimal = [];
  for (const scope of inspected) {
    const covered = minimal.some((parent) => parent.kind === "directory" && isWithin(parent.absolute, scope.absolute));
    if (!covered) minimal.push(scope);
  }
  return minimal;
}

function scopeContains(scope, target) {
  return scope.kind === "file"
    ? path.resolve(scope.absolute) === path.resolve(target)
    : isWithin(scope.absolute, target);
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function groupMatches(matches) {
  const grouped = new Map();
  for (const match of matches || []) {
    const list = grouped.get(match.absolute_path) || [];
    list.push(match);
    grouped.set(match.absolute_path, list);
  }
  return grouped;
}

function publicMatch(match) {
  return {
    path: match.path,
    line: match.line,
    range: match.range,
    node_kind: match.node_kind,
    text: bounded(match.text),
    replacement: bounded(match.replacement),
    captures: match.captures
  };
}

function normalizeRange(range = {}) {
  return {
    start: {
      line: Number(range?.start?.line || 0) + 1,
      column: Number(range?.start?.column || 0)
    },
    end: {
      line: Number(range?.end?.line || 0) + 1,
      column: Number(range?.end?.column || 0)
    }
  };
}

function normalizeCaptures(metaVariables = {}) {
  const result = {};
  for (const [name, value] of Object.entries(metaVariables?.single || {})) {
    result[name] = bounded(value?.text ?? value);
  }
  for (const [name, values] of Object.entries(metaVariables?.multi || {})) {
    result[name] = (Array.isArray(values) ? values : [values]).map((value) => bounded(value?.text ?? value));
  }
  for (const [name, value] of Object.entries(metaVariables?.transformed || {})) {
    result[name] = bounded(value?.text ?? value);
  }
  return result;
}

function bounded(value) {
  const text = String(value ?? "");
  return text.length > MAX_PREVIEW_TEXT_CHARS ? `${text.slice(0, MAX_PREVIEW_TEXT_CHARS)}…` : text;
}

function cleanError(value) {
  return String(value || "ast-grep rewrite failed")
    .replace(/Debug (?:AST|CST):[\s\S]*?(?:\n\n|$)/, "")
    .trim()
    .slice(0, 2_000) || "ast-grep rewrite failed";
}

function round(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}
