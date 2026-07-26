// Local Coding Agent TUI — persistent local UI state
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

export const TUI_STATE_SCHEMA = 1;

export function defaultTuiStatePath(configPath) {
  return path.join(path.dirname(path.resolve(configPath)), "tui-state.json");
}

export function normalizeViewOrder(allViewIds, storedOrder = []) {
  const allowed = new Set(allViewIds.map(String));
  const result = [];
  for (const id of Array.isArray(storedOrder) ? storedOrder : []) {
    const value = String(id);
    if (!allowed.has(value) || result.includes(value)) continue;
    result.push(value);
  }
  for (const id of allViewIds) {
    const value = String(id);
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

export function reorderItems(items, sourceIndex, targetIndex) {
  const result = [...items];
  const source = clampIndex(sourceIndex, result.length);
  const target = clampIndex(targetIndex, result.length);
  if (source === target || !result.length) return result;
  const [item] = result.splice(source, 1);
  result.splice(target, 0, item);
  return result;
}

export function normalizeRecentDirectories(values, limit = 12) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== "string" || !value.trim()) continue;
    const directory = path.resolve(value.trim());
    if (result.includes(directory) || !isDirectory(directory)) continue;
    result.push(directory);
    if (result.length >= limit) break;
  }
  return result;
}

export function loadTuiState(file, options = {}) {
  const allViewIds = options.allViewIds || [];
  const fallback = {
    schema: TUI_STATE_SCHEMA,
    active_view: allViewIds.includes(options.activeView) ? options.activeView : allViewIds[0] || "dashboard",
    view_order: normalizeViewOrder(allViewIds),
    recent_directories: normalizeRecentDirectories(options.recentDirectories || []),
    last_directory: normalizeRecentDirectories([options.lastDirectory, ...(options.recentDirectories || [])], 1)[0] || ""
  };
  if (!file || !existsSync(file)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const recentDirectories = normalizeRecentDirectories([
      parsed?.last_directory,
      ...(parsed?.recent_directories || []),
      ...(options.recentDirectories || [])
    ]);
    return {
      schema: TUI_STATE_SCHEMA,
      active_view: allViewIds.includes(parsed?.active_view) ? parsed.active_view : fallback.active_view,
      view_order: normalizeViewOrder(allViewIds, parsed?.view_order),
      recent_directories: recentDirectories,
      last_directory: recentDirectories[0] || fallback.last_directory
    };
  } catch {
    return fallback;
  }
}

export function saveTuiState(file, state) {
  if (!file) return;
  const target = path.resolve(file);
  mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const recentDirectories = normalizeRecentDirectories(state?.recent_directories || []);
  const payload = {
    schema: TUI_STATE_SCHEMA,
    active_view: typeof state?.active_view === "string" ? state.active_view : "dashboard",
    view_order: Array.isArray(state?.view_order) ? state.view_order.map(String) : [],
    recent_directories: recentDirectories,
    last_directory: normalizeRecentDirectories([state?.last_directory, ...recentDirectories], 1)[0] || ""
  };
  writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
}

function clampIndex(value, length) {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, Number(value) || 0));
}

function isDirectory(value) {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}
