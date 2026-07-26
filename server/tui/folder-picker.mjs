// Local Coding Agent TUI — local directory picker helpers
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdir } from "node:fs/promises";
import path from "node:path";

export async function directoryPickerRows(currentDirectory, options = {}) {
  const current = path.resolve(currentDirectory);
  const entries = await readdir(current, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      kind: "directory",
      name: entry.name,
      path: path.join(current, entry.name),
      label: `▸ ${entry.name}`
    }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));

  const rows = [{
    kind: "select",
    path: current,
    label: "✓ Select this folder"
  }];
  const parent = path.dirname(current);
  if (parent !== current) rows.push({ kind: "parent", path: parent, label: "↰ ..  Parent folder" });

  const recent = [];
  for (const value of Array.isArray(options.recentDirectories) ? options.recentDirectories : []) {
    const directory = path.resolve(value);
    if (directory === current || directory === parent || recent.some((item) => item.path === directory)) continue;
    recent.push({
      kind: "recent",
      path: directory,
      label: `★ ${path.basename(directory) || directory}  ${compactPickerPath(directory, 52)}`
    });
    if (recent.length >= 6) break;
  }
  if (recent.length) rows.push(...recent);
  rows.push(...directories);
  return rows;
}

export function compactPickerPath(value, max = 64) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `…/${text.slice(-(max - 2)).replace(/^[/\\]+/, "")}`;
}

export function nextPickerDirectory(row, currentDirectory) {
  if (!row || row.kind === "select") return path.resolve(currentDirectory);
  return path.resolve(row.path || currentDirectory);
}
