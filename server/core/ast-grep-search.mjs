import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_STDERR_CHARS = 12_000;
const MAX_MATCH_TEXT_CHARS = 4_000;
const MAX_CAPTURE_TEXT_CHARS = 2_000;

export function createAstGrepSearch({
  binary = null,
  toRel = (value) => value,
  runProcess = runAstGrepProcess,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  async function search({ start, pattern, lang, limit = 100, glob = null } = {}) {
    const requestedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    if (!binary) {
      return {
        ok: false,
        engine: "ast-grep",
        available: false,
        reason: "ast-grep CLI unavailable",
        pattern,
        lang,
        path: toRel(start),
        count: 0,
        truncated: false,
        matches: []
      };
    }

    const info = await stat(start).catch(() => null);
    if (!info) {
      return {
        ok: false,
        engine: "ast-grep",
        available: true,
        reason: "search path does not exist",
        pattern,
        lang,
        path: toRel(start),
        count: 0,
        truncated: false,
        matches: []
      };
    }

    const cwd = info.isDirectory() ? start : path.dirname(start);
    const target = info.isDirectory() ? "." : path.basename(start);
    const args = buildAstGrepArgs({ pattern, lang, target, glob });
    const started = performance.now();
    const result = await runProcess({
      binary,
      args,
      cwd,
      limit: requestedLimit,
      timeoutMs
    });
    const durationMs = round(performance.now() - started);
    const nodeKind = inferPatternNodeKind(result.stderr);
    const matches = (result.matches || [])
      .slice(0, requestedLimit)
      .map((match) => normalizeAstGrepMatch(match, { cwd, toRel, nodeKind }));
    const noMatches = result.exit_code === 1 && matches.length === 0;
    const failed = result.exit_code !== 0 && !noMatches && !result.stopped_early;

    return {
      ok: !failed,
      engine: "ast-grep",
      available: true,
      pattern,
      lang,
      path: toRel(start),
      duration_ms: durationMs,
      count: matches.length,
      truncated: Boolean(result.stopped_early || (result.matches || []).length > requestedLimit),
      matches,
      ...(failed ? {
        error: cleanError(result.stderr || `ast-grep exited with code ${result.exit_code}`)
      } : {})
    };
  }

  return { search };
}

export function buildAstGrepArgs({ pattern, lang, target = ".", glob = null } = {}) {
  const args = [
    "run",
    "--pattern", String(pattern || ""),
    "--lang", String(lang || ""),
    "--debug-query=ast",
    "--json=stream",
    "--color", "never"
  ];
  if (glob) args.push("--globs", String(glob));
  args.push(target);
  return args;
}

export function normalizeAstGrepMatch(match, { cwd = ".", toRel = (value) => value, nodeKind = null } = {}) {
  const absolute = path.isAbsolute(match?.file || "")
    ? path.resolve(match.file)
    : path.resolve(cwd, match?.file || "");
  const text = String(match?.text || "");
  return {
    path: toRel(absolute),
    line: Number(match?.range?.start?.line || 0) + 1,
    range: normalizeRange(match?.range),
    node_kind: nodeKind || null,
    text: text.slice(0, MAX_MATCH_TEXT_CHARS),
    text_truncated: text.length > MAX_MATCH_TEXT_CHARS,
    captures: normalizeCaptures(match?.metaVariables)
  };
}

export function inferPatternNodeKind(stderr = "") {
  const marker = String(stderr).match(/Debug (?:AST|CST):\s*\n([\s\S]*?)(?:\n\n|$)/);
  if (!marker) return null;
  const rows = marker[1]
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(\s*)([A-Za-z_][\w-]*)\s+\(/);
      return match ? { indent: match[1].length, kind: match[2] } : null;
    })
    .filter(Boolean);
  if (!rows.length) return null;

  const root = rows[0];
  const directChildren = rows.filter((row, index) => index > 0 && row.indent === root.indent + 2);
  if (["program", "source_file"].includes(root.kind)) {
    if (directChildren.length !== 1) return root.kind;
    const child = directChildren[0];
    if (child.kind !== "expression_statement") return child.kind;
    const childIndex = rows.indexOf(child);
    const expressionChild = rows.slice(childIndex + 1).find((row) => row.indent === child.indent + 2);
    return expressionChild?.kind || child.kind;
  }
  return root.kind;
}

export async function runAstGrepProcess({
  binary,
  args,
  cwd,
  limit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawn
} = {}) {
  return new Promise((resolve) => {
    let child;
    let stderr = "";
    let buffer = "";
    let exitCode = null;
    let timedOut = false;
    let stoppedEarly = false;
    let settled = false;
    const matches = [];

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      consumeBuffer(true);
      resolve({
        exit_code: exitCode,
        timed_out: timedOut,
        stopped_early: stoppedEarly,
        stderr: stderr.slice(-MAX_STDERR_CHARS),
        matches
      });
    };

    const consumeLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed || matches.length >= limit) return;
      try {
        matches.push(JSON.parse(trimmed));
      } catch {
        if (stderr.length < MAX_STDERR_CHARS) stderr += `Invalid ast-grep JSON output: ${trimmed.slice(0, 500)}\n`;
      }
      if (matches.length >= limit && child && !child.killed) {
        stoppedEarly = true;
        child.kill("SIGTERM");
      }
    };

    const consumeBuffer = (final = false) => {
      const lines = buffer.split(/\r?\n/);
      const tail = lines.pop() || "";
      buffer = final ? "" : tail;
      for (const line of lines) consumeLine(line);
      if (final && tail.trim()) consumeLine(tail);
    };

    try {
      child = spawnImpl(binary, args, { cwd, windowsHide: true });
    } catch (error) {
      resolve({
        exit_code: null,
        timed_out: false,
        stopped_early: false,
        stderr: String(error?.message || error),
        matches: []
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      if (child && !child.killed) child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk) => {
      buffer += chunk.toString();
      consumeBuffer(false);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString().slice(0, MAX_STDERR_CHARS - stderr.length);
    });
    child.on("error", (error) => {
      stderr += String(error?.message || error);
      exitCode = null;
      finish();
    });
    child.on("close", (code) => {
      exitCode = code;
      finish();
    });
  });
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
  const captures = {};
  for (const [name, value] of Object.entries(metaVariables?.single || {})) {
    captures[name] = normalizeCapture(value);
  }
  for (const [name, values] of Object.entries(metaVariables?.multi || {})) {
    captures[name] = (Array.isArray(values) ? values : [values]).map(normalizeCapture);
  }
  for (const [name, value] of Object.entries(metaVariables?.transformed || {})) {
    captures[name] = typeof value === "string"
      ? value.slice(0, MAX_CAPTURE_TEXT_CHARS)
      : normalizeCapture(value);
  }
  return captures;
}

function normalizeCapture(value = {}) {
  const text = String(value?.text ?? value ?? "");
  return {
    text: text.slice(0, MAX_CAPTURE_TEXT_CHARS),
    truncated: text.length > MAX_CAPTURE_TEXT_CHARS,
    ...(value?.range ? { range: normalizeRange(value.range) } : {})
  };
}

function cleanError(value) {
  return String(value || "ast-grep failed")
    .replace(/Debug (?:AST|CST):[\s\S]*?(?:\n\n|$)/, "")
    .trim()
    .slice(0, 2_000) || "ast-grep failed";
}

function round(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}
