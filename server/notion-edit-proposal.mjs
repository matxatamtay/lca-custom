// Local Coding Agent — staged Notion edit proposals
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { parseNotionEnhancedMarkdown } from "./notion-enhanced-markdown.mjs";

const PROPOSAL_SCOPES = new Set(["whole_page", "selected_blocks", "selected_text"]);

export function notionMarkdownSha256(markdown) {
  return createHash("sha256").update(String(markdown ?? ""), "utf8").digest("hex");
}

export function buildNotionEditProposal(page, input = {}) {
  if (!page?.id || typeof page.markdown !== "string") {
    throw new Error("A complete fetched Notion page is required to build an edit proposal.");
  }
  if (page.truncated || page.unknown_block_ids?.length) {
    throw new Error("Cannot stage an edit from an incomplete Notion Markdown snapshot.");
  }

  const scope = PROPOSAL_SCOPES.has(input.proposal_scope) ? input.proposal_scope : "whole_page";
  const originalMarkdown = page.markdown;
  let proposedMarkdown;
  let source = null;
  let replacement = null;

  if (scope === "whole_page") {
    if (typeof input.proposal_markdown !== "string") {
      throw new Error("Whole-page proposals require proposal_markdown.");
    }
    proposedMarkdown = input.proposal_markdown;
  } else {
    source = String(input.proposal_source ?? "");
    replacement = String(input.proposal_replacement ?? "");
    if (!source) throw new Error("Selected-content proposals require proposal_source.");
    const occurrences = countOccurrences(originalMarkdown, source);
    if (occurrences !== 1) {
      throw new Error(`Selected proposal source must match the current page exactly once; found ${occurrences}.`);
    }
    proposedMarkdown = replaceOnce(originalMarkdown, source, replacement);
  }

  if (proposedMarkdown === originalMarkdown) throw new Error("The proposed edit does not change the page.");

  const originalSha256 = page.markdown_sha256 || notionMarkdownSha256(originalMarkdown);
  const proposedSha256 = notionMarkdownSha256(proposedMarkdown);
  return {
    id: `proposal-${proposedSha256.slice(0, 16)}`,
    scope,
    prompt: String(input.proposal_prompt ?? "").trim(),
    source,
    replacement,
    base_page_id: page.id,
    base_last_edited_time: page.last_edited_time || null,
    base_markdown_sha256: originalSha256,
    proposed_markdown_sha256: proposedSha256,
    proposed_markdown: proposedMarkdown,
    proposed_render_blocks: parseNotionEnhancedMarkdown(proposedMarkdown),
    diff: buildSideBySideLineDiff(originalMarkdown, proposedMarkdown),
    stats: diffStats(originalMarkdown, proposedMarkdown)
  };
}

export function buildSideBySideLineDiff(original, proposed) {
  const left = String(original ?? "").split("\n");
  const right = String(proposed ?? "").split("\n");
  const pairs = alignLines(left, right);
  let leftLine = 0;
  let rightLine = 0;
  return pairs.map(([before, after]) => {
    if (before !== null) leftLine += 1;
    if (after !== null) rightLine += 1;
    const type = before === after ? "equal" : before === null ? "add" : after === null ? "remove" : "change";
    return {
      type,
      left_line: before === null ? null : leftLine,
      right_line: after === null ? null : rightLine,
      left: before,
      right: after
    };
  });
}

function alignLines(left, right) {
  if (left.length * right.length > 250_000) return coarseAlignment(left, right);
  const matrix = Array.from({ length:left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      matrix[i][j] = left[i] === right[j]
        ? matrix[i + 1][j + 1] + 1
        : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }

  const raw = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      raw.push([left[i], right[j]]); i += 1; j += 1; continue;
    }
    if (j < right.length && (i === left.length || matrix[i][j + 1] >= matrix[i + 1][j])) {
      raw.push([null, right[j]]); j += 1; continue;
    }
    raw.push([left[i], null]); i += 1;
  }
  return pairChanges(raw);
}

function pairChanges(rows) {
  const output = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i][0] !== null && rows[i][1] !== null) { output.push(rows[i]); i += 1; continue; }
    const removed = [];
    const added = [];
    while (i < rows.length && (rows[i][0] === null || rows[i][1] === null)) {
      if (rows[i][0] !== null) removed.push(rows[i][0]);
      if (rows[i][1] !== null) added.push(rows[i][1]);
      i += 1;
    }
    const size = Math.max(removed.length, added.length);
    for (let index = 0; index < size; index += 1) {
      output.push([removed[index] ?? null, added[index] ?? null]);
    }
  }
  return output;
}

function coarseAlignment(left, right) {
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix && suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) suffix += 1;
  const output = left.slice(0, prefix).map((line) => [line, line]);
  const leftMiddle = left.slice(prefix, left.length - suffix);
  const rightMiddle = right.slice(prefix, right.length - suffix);
  const middleSize = Math.max(leftMiddle.length, rightMiddle.length);
  for (let index = 0; index < middleSize; index += 1) output.push([leftMiddle[index] ?? null, rightMiddle[index] ?? null]);
  for (let index = suffix; index > 0; index -= 1) {
    const line = left[left.length - index];
    output.push([line, line]);
  }
  return output;
}

function diffStats(original, proposed) {
  const rows = buildSideBySideLineDiff(original, proposed);
  return rows.reduce((stats, row) => {
    if (row.type === "add") stats.added += 1;
    else if (row.type === "remove") stats.removed += 1;
    else if (row.type === "change") stats.changed += 1;
    return stats;
  }, { added:0, removed:0, changed:0 });
}

function replaceOnce(value, source, replacement) {
  const index = value.indexOf(source);
  return `${value.slice(0, index)}${replacement}${value.slice(index + source.length)}`;
}

function countOccurrences(value, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}
