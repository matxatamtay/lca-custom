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

import { normalizeResourceTabs } from "./resource-tabs.mjs";

export const TUI_STATE_SCHEMA = 2;
export const DEFAULT_PANE_SPLIT_PERCENT = 40;

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

export function normalizePaneSplitPercent(value, fallback = DEFAULT_PANE_SPLIT_PERCENT) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(22, Math.min(76, Math.round(numeric))) : fallback;
}

export function commandHistoryScope(value, fallback = process.cwd()) {
  return path.resolve(typeof value === "string" && value.trim() ? value : fallback);
}

export function normalizeCommandHistories(value, options = {}) {
  const maxProjects = Math.max(1, Number(options.maxProjects) || 20);
  const maxEntries = Math.max(1, Number(options.maxEntries) || 50);
  const maxOutputChars = Math.max(100, Number(options.maxOutputChars) || 8_000);
  const result = {};
  const source = value && typeof value === "object" ? value : {};
  for (const [rawScope, rawEntries] of Object.entries(source).slice(0, maxProjects)) {
    const scope = commandHistoryScope(rawScope);
    if (!isDirectory(scope)) continue;
    const entries = [];
    for (const item of Array.isArray(rawEntries) ? rawEntries.slice(-maxEntries) : []) {
      const command = typeof item?.command === "string" ? item.command.trim() : "";
      if (!command) continue;
      entries.push({
        command: command.slice(0, 2_000),
        cwd: commandHistoryScope(item.cwd, scope),
        ok: item.ok === true,
        exit_code: Number.isFinite(Number(item.exit_code)) ? Number(item.exit_code) : null,
        timed_out: item.timed_out === true,
        output: String(item.output ?? "").slice(0, maxOutputChars),
        created_at: typeof item.created_at === "string" ? item.created_at : new Date(0).toISOString()
      });
    }
    if (entries.length) result[scope] = entries;
  }
  return result;
}

export function appendCommandHistory(histories, scope, entry, options = {}) {
  const key = commandHistoryScope(scope);
  const normalized = normalizeCommandHistories({ [key]: [...(histories?.[key] || []), entry] }, options);
  return { ...(histories || {}), [key]: normalized[key] || [] };
}

export function loadTuiState(file, options = {}) {
  const allViewIds = options.allViewIds || [];
  const fallbackWorkspace = path.resolve(
    options.fallbackWorkspace || options.lastDirectory || options.recentDirectories?.[0] || process.cwd()
  );
  const fallbackTabs = normalizeResourceTabs([], fallbackWorkspace);
  const fallback = {
    schema: TUI_STATE_SCHEMA,
    active_view: allViewIds.includes(options.activeView) ? options.activeView : allViewIds[0] || "dashboard",
    view_order: normalizeViewOrder(allViewIds),
    recent_directories: normalizeRecentDirectories(options.recentDirectories || []),
    last_directory: normalizeRecentDirectories([options.lastDirectory, ...(options.recentDirectories || [])], 1)[0] || fallbackWorkspace,
    pane_split_percent: DEFAULT_PANE_SPLIT_PERCENT,
    resource_tabs: fallbackTabs,
    active_resource_tab: fallbackTabs[0]?.id || "",
    command_histories: {}
  };
  if (!file || !existsSync(file)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const recentDirectories = normalizeRecentDirectories([
      parsed?.last_directory,
      ...(parsed?.recent_directories || []),
      ...(options.recentDirectories || [])
    ]);
    const resourceTabs = normalizeResourceTabs(parsed?.resource_tabs, fallbackWorkspace);
    return {
      schema: TUI_STATE_SCHEMA,
      active_view: allViewIds.includes(parsed?.active_view) ? parsed.active_view : fallback.active_view,
      view_order: normalizeViewOrder(allViewIds, parsed?.view_order),
      recent_directories: recentDirectories,
      last_directory: recentDirectories[0] || fallback.last_directory,
      pane_split_percent: normalizePaneSplitPercent(parsed?.pane_split_percent),
      resource_tabs: resourceTabs,
      active_resource_tab: resourceTabs.some((tab) => tab.id === parsed?.active_resource_tab)
        ? parsed.active_resource_tab
        : resourceTabs[0]?.id || fallback.active_resource_tab,
      command_histories: normalizeCommandHistories(parsed?.command_histories)
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
  const fallbackWorkspace = normalizeRecentDirectories([state?.last_directory, ...recentDirectories], 1)[0] || process.cwd();
  const resourceTabs = normalizeResourceTabs(state?.resource_tabs, fallbackWorkspace);
  const payload = {
    schema: TUI_STATE_SCHEMA,
    active_view: typeof state?.active_view === "string" ? state.active_view : "dashboard",
    view_order: Array.isArray(state?.view_order) ? state.view_order.map(String) : [],
    recent_directories: recentDirectories,
    last_directory: fallbackWorkspace,
    pane_split_percent: normalizePaneSplitPercent(state?.pane_split_percent),
    resource_tabs: resourceTabs,
    active_resource_tab: resourceTabs.some((tab) => tab.id === state?.active_resource_tab)
      ? state.active_resource_tab
      : resourceTabs[0]?.id || "",
    command_histories: normalizeCommandHistories(state?.command_histories)
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
