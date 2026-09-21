import { spawnSync } from "node:child_process";
import path from "node:path";

export function resultLen(result) {
  try {
    let n = 0;
    for (const c of result?.content || []) n += (c?.text || "").length;
    return n;
  } catch {
    return 0;
  }
}

export function firstText(result) {
  try {
    return result?.content?.[0]?.text || "";
  } catch {
    return "";
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
export function dedupe(arr) {
  return [...new Set(arr)];
}

export function boundedNumber(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function parseExtraRoots(startupProfile = null) {
  const json = process.env.AGENT_EXTRA_ROOTS_JSON;
  if (json && json.trim()) {
    try {
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== "string")) {
        throw new Error("AGENT_EXTRA_ROOTS_JSON must be a JSON string array.");
      }
      return dedupe([...parsed, ...(Array.isArray(startupProfile?.extraRoots) ? STARTUP_PROFILE.extraRoots : [])]).map((p) => path.resolve(p));
    } catch (err) {
      console.warn(`Invalid AGENT_EXTRA_ROOTS_JSON ignored: ${err?.message || err}`);
    }
  }
  return dedupe([
    ...(process.env.AGENT_EXTRA_ROOTS || "").split(";"),
    ...(Array.isArray(startupProfile?.extraRoots) ? STARTUP_PROFILE.extraRoots : [])
  ])
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

export function hasCommand(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore", windowsHide: true });
  return !result.error;
}

export function comparePath(p) {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isoNow() {
  return new Date().toISOString();
}

export function appendLimited(current, next, max) {
  const combined = current + next;
  if (combined.length <= max) return combined;
  return combined.slice(combined.length - max);
}

// Trim command output for display: prefer line slicing (head/tail), else cap chars.
export function trimOutput(s, { tail_lines, head_lines, max_chars }) {
  if (!s) return s;
  if (head_lines || tail_lines) {
    const lines = s.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop(); // drop trailing newline's empty line
    const picked = head_lines ? lines.slice(0, head_lines) : lines.slice(-tail_lines);
    const out = picked.join("\n");
    return out.length > max_chars ? out.slice(0, max_chars) : out;
  }
  return s.length > max_chars ? s.slice(0, max_chars) : s;
}

