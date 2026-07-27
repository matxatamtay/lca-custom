// Local Coding Agent TUI — workspace and file tab state
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { statSync } from "node:fs";
import path from "node:path";

const VALID_KINDS = new Set(["workspace", "file"]);

export function resourceTabId(kind, value) {
  return `${kind}:${path.resolve(value)}`;
}

export function createResourceTab(kind, value, options = {}) {
  const normalizedKind = VALID_KINDS.has(kind) ? kind : "workspace";
  const absolute = path.resolve(value);
  return {
    id: resourceTabId(normalizedKind, absolute),
    kind: normalizedKind,
    path: absolute,
    title: String(options.title || path.basename(absolute) || absolute).slice(0, 80),
    pinned: options.pinned === true,
    ...(normalizedKind === "workspace" ? { current_path: existingDirectory(options.current_path) || absolute } : {})
  };
}

export function normalizeResourceTabs(values, fallbackWorkspace, limit = 24) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (!value || typeof value !== "object" || !VALID_KINDS.has(value.kind) || typeof value.path !== "string") continue;
    const tab = createResourceTab(value.kind, value.path, value);
    if (!resourceExists(tab) || result.some((item) => item.id === tab.id)) continue;
    result.push(tab);
    if (result.length >= limit) break;
  }
  const fallback = createResourceTab("workspace", fallbackWorkspace);
  if (!result.some((item) => item.kind === "workspace")) result.unshift(fallback);
  return sortPinnedTabs(result).slice(0, limit);
}

export function upsertResourceTab(tabs, tab, limit = 24) {
  const normalized = createResourceTab(tab.kind, tab.path, tab);
  const source = Array.isArray(tabs) ? tabs.filter((item) => item.id !== normalized.id) : [];
  const sorted = sortPinnedTabs([...source, normalized]);
  if (sorted.length <= limit) return sorted;
  const pinned = sorted.filter((item) => item.pinned).slice(0, limit);
  const available = Math.max(0, limit - pinned.length);
  const recentUnpinned = sorted.filter((item) => !item.pinned).slice(-available);
  return [...pinned, ...recentUnpinned];
}

export function toggleResourceTabPinned(tabs, id) {
  return sortPinnedTabs((Array.isArray(tabs) ? tabs : []).map((tab) => tab.id === id ? { ...tab, pinned: !tab.pinned } : tab));
}

export function updateWorkspaceTabLocation(tabs, id, directory) {
  const currentPath = existingDirectory(directory);
  if (!currentPath) return Array.isArray(tabs) ? tabs : [];
  return (Array.isArray(tabs) ? tabs : []).map((tab) => tab.id === id && tab.kind === "workspace"
    ? { ...tab, current_path: currentPath }
    : tab);
}

export function closeResourceTab(tabs, id, fallbackWorkspace) {
  const source = Array.isArray(tabs) ? tabs : [];
  const target = source.find((tab) => tab.id === id);
  if (!target || target.pinned) return { tabs: source, closed: false, reason: target?.pinned ? "pinned" : "missing" };
  let next = source.filter((tab) => tab.id !== id);
  if (!next.some((tab) => tab.kind === "workspace")) next = [createResourceTab("workspace", fallbackWorkspace), ...next];
  return { tabs: sortPinnedTabs(next), closed: true, reason: null };
}

export function nextResourceTabId(tabs, activeId, direction = 1) {
  const source = Array.isArray(tabs) ? tabs : [];
  if (!source.length) return null;
  const current = Math.max(0, source.findIndex((tab) => tab.id === activeId));
  return source[(current + direction + source.length) % source.length]?.id ?? null;
}

function sortPinnedTabs(tabs) {
  return tabs.map((tab, index) => ({ tab, index }))
    .sort((left, right) => Number(right.tab.pinned) - Number(left.tab.pinned) || left.index - right.index)
    .map((entry) => entry.tab);
}

function resourceExists(tab) {
  try {
    const stat = statSync(tab.path);
    return tab.kind === "workspace" ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

function existingDirectory(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const absolute = path.resolve(value);
  try {
    return statSync(absolute).isDirectory() ? absolute : "";
  } catch {
    return "";
  }
}
