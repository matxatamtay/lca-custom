// Local Coding Agent TUI — fuzzy command palette helpers
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

export function fuzzyFilter(items, query, limit = 100) {
  const source = Array.isArray(items) ? items : [];
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return source.slice(0, limit);
  return source
    .map((item, index) => ({ item, index, score: fuzzyScore(item?.searchText || item?.label || "", needle) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

export function fuzzyScore(value, query) {
  const text = String(value ?? "").toLowerCase();
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return 0;
  const direct = text.indexOf(needle);
  if (direct >= 0) return 10_000 - direct * 8 - Math.max(0, text.length - needle.length);

  let score = 0;
  let position = -1;
  let streak = 0;
  for (const character of needle) {
    const next = text.indexOf(character, position + 1);
    if (next < 0) return Number.NEGATIVE_INFINITY;
    const contiguous = next === position + 1;
    const boundary = next === 0 || /[\s/_.:>\-]/.test(text[next - 1]);
    streak = contiguous ? streak + 1 : 0;
    score += 30 + streak * 18 + (boundary ? 35 : 0) - Math.max(0, next - position - 1) * 2;
    position = next;
  }
  return score - Math.max(0, text.length - needle.length);
}
