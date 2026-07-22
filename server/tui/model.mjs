// Local Coding Agent TUI — pure state and formatting helpers
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";

export const TUI_VIEWS = Object.freeze([
  { id: "dashboard", label: "Dashboard", key: "d", icon: "◆" },
  { id: "projects", label: "Projects", key: "p", icon: "▣" },
  { id: "files", label: "Files", key: "f", icon: "▤" },
  { id: "search", label: "Search", key: "/", icon: "⌕" },
  { id: "context", label: "Context", key: "x", icon: "◈" },
  { id: "git", label: "Git", key: "g", icon: "⑂" },
  { id: "commands", label: "Commands", key: "c", icon: "▶" },
  { id: "processes", label: "Processes", key: "o", icon: "◉" },
  { id: "verify", label: "Verify", key: "v", icon: "✓" },
  { id: "tasks", label: "Tasks & Notes", key: "t", icon: "☷" },
  { id: "skills", label: "Skills", key: "k", icon: "✦" },
  { id: "integrations", label: "Integrations", key: "i", icon: "⌁" },
  { id: "memory", label: "Memory", key: "m", icon: "∞" },
  { id: "tools", label: "Tool Console", key: "a", icon: "⌘" },
  { id: "logs", label: "Logs", key: "l", icon: "≋" },
  { id: "help", label: "Help", key: "h", icon: "?" }
]);

export const TUI_SHORTCUTS = Object.freeze([
  ["Mouse", "click navigation, rows, buttons, and scrollbars"],
  ["↑/↓ or j/k", "move in the focused list"],
  ["Enter", "open the selected row"],
  ["Tab / Shift+Tab", "cycle focus"],
  ["r", "refresh the active screen"],
  ["Ctrl+P", "open the command palette"],
  ["/", "open Search"],
  ["d p f x g c o v t k i m a l h", "jump directly to a screen"],
  ["?", "show Help"],
  ["q or Ctrl+C", "quit the TUI, leaving the managed LCA daemon running"]
]);

export function compactFacadeCall(facade, action, args = {}) {
  if (facade === "workspace_context" || facade === "lca_input") {
    return { name: facade, arguments: args };
  }
  return {
    name: facade,
    arguments: {
      ...(action ? { action } : {}),
      arguments: args && typeof args === "object" ? args : {}
    }
  };
}

export function textFromToolResult(result) {
  return (result?.content ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

export function dataFromToolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = textFromToolResult(result).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function formatToolResult(result, maxChars = 120_000) {
  const data = dataFromToolResult(result);
  const rendered = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const text = rendered || "(empty result)";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n… truncated ${text.length - maxChars} characters`;
}

export function formatBytes(value) {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatDuration(value) {
  const ms = Number(value ?? 0);
  if (!Number.isFinite(ms)) return "?";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function compactPath(value, max = 72) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  const tail = text.slice(-(max - 2));
  return `…/${tail.replace(/^[/\\]+/, "")}`;
}

export function safeJsonParse(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
}

export function normalizeFileEntries(value) {
  const entries = Array.isArray(value?.entries) ? value.entries : [];
  return entries.map((entry) => ({
    ...entry,
    path: String(entry.path ?? ""),
    type: String(entry.type ?? "file"),
    label: `${entry.type === "directory" ? "▸" : "·"} ${path.basename(String(entry.path ?? "")) || String(entry.path ?? "")}${entry.type === "file" && Number.isFinite(Number(entry.size)) ? `  ${formatBytes(entry.size)}` : ""}`
  }));
}

export function normalizeSearchMatches(value) {
  const matches = Array.isArray(value?.matches) ? value.matches : [];
  return matches.map((match) => ({
    ...match,
    path: String(match.path ?? ""),
    line: Number(match.line ?? 1),
    label: `${compactPath(match.path, 48)}:${match.line ?? "?"}  ${String(match.text ?? "").trim()}`
  }));
}

export function normalizeGitRows(value) {
  const files = Array.isArray(value?.files) ? value.files : [];
  return files.map((file) => ({
    ...file,
    path: String(file.path ?? ""),
    label: `${String(file.index ?? " ")}${String(file.worktree ?? " ")}  ${file.path}`
  }));
}

export function normalizeProcesses(value) {
  const processes = Array.isArray(value?.processes) ? value.processes : [];
  return processes.map((process) => ({
    ...process,
    label: `${process.status === "running" ? "●" : "○"} ${process.name || process.id}  pid=${process.pid ?? "-"}  ${process.command || ""}`
  }));
}

export function normalizeSkills(value) {
  const skills = Array.isArray(value?.skills) ? value.skills : [];
  return skills.map((skill) => ({
    ...skill,
    label: `✦ ${skill.name}${skill.description ? `  ${skill.description}` : ""}`
  }));
}

export function viewByShortcut(keyName, sequence = "") {
  const key = String(sequence || keyName || "").toLowerCase();
  if (key === "?") return TUI_VIEWS.find((view) => view.id === "help") ?? null;
  return TUI_VIEWS.find((view) => view.key === key) ?? null;
}

export function selectedRow(rows, index) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const normalized = Math.max(0, Math.min(rows.length - 1, Number(index) || 0));
  return rows[normalized] ?? null;
}

export function dashboardText({ health, info, doctor, integrations, memory, launcher }) {
  const lines = [];
  lines.push("{bold}Local Coding Agent{/bold}");
  lines.push("");
  lines.push(`Runtime       ${badge(health?.status === "ok", health?.runtime || "offline")}`);
  lines.push(`Surface       ${health?.tool_surface || "-"}`);
  lines.push(`Version       ${health?.version || "-"}`);
  lines.push(`Server PID    ${health?.pid ?? launcher?.pids?.server ?? "-"}`);
  lines.push(`Tunnel PID    ${launcher?.pids?.tunnel ?? "-"} ${launcher?.pids?.tunnel_alive ? "{green-fg}●{/green-fg}" : "{red-fg}○{/red-fg}"}`);
  lines.push(`Primary       ${info?.primary_root || info?.workspace || health?.workspace || "-"}`);
  lines.push(`Projects      ${(info?.roots || launcher?.projects || []).length}`);
  lines.push(`Doctor        ${doctor?.status || "-"}  ${doctor?.summary ? `${doctor.summary.pass} pass / ${doctor.summary.warn} warn / ${doctor.summary.fail} fail` : ""}`);
  lines.push(`AgentMemory   ${memory?.status || (memory?.service?.ready ? "healthy" : "offline")}`);
  lines.push("");
  lines.push("{bold}Desktop integrations{/bold}");
  for (const item of integrations ?? []) {
    lines.push(`${String(item.name).padEnd(13)} ${badge(item.ok, item.detail || (item.ok ? "connected" : "offline"))}`);
  }
  lines.push("");
  lines.push("{gray-fg}Click a navigation item or press its shortcut. Ctrl+P opens every action from one palette.{/gray-fg}");
  return lines.join("\n");
}

function badge(ok, text) {
  return ok ? `{green-fg}● ${text}{/green-fg}` : `{red-fg}○ ${text}{/red-fg}`;
}
