// Staged Notion edit proposal tests
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNotionEditProposal,
  buildSideBySideLineDiff,
  notionMarkdownSha256
} from "./notion-edit-proposal.mjs";

const PAGE = {
  id: "b55c9c91-384d-452b-81db-d1ef79372b75",
  title: "Proposal fixture",
  last_edited_time: "2026-08-08T12:00:00.000Z",
  markdown: "# Title\n\nFirst paragraph.\n\nSecond paragraph.",
  truncated: false,
  unknown_block_ids: []
};

test("whole-page proposal is preview-only and carries a base fingerprint", () => {
  const proposal = buildNotionEditProposal(PAGE, {
    proposal_scope: "whole_page",
    proposal_prompt: "Make it shorter",
    proposal_markdown: "# Title\n\nShort version."
  });
  assert.equal(proposal.scope, "whole_page");
  assert.equal(proposal.base_markdown_sha256, notionMarkdownSha256(PAGE.markdown));
  assert.equal(proposal.proposed_markdown, "# Title\n\nShort version.");
  assert.ok(proposal.diff.some((row) => row.type !== "equal"));
  assert.ok(Array.isArray(proposal.proposed_render_blocks));
});

test("selected proposal replaces exactly one source region", () => {
  const proposal = buildNotionEditProposal(PAGE, {
    proposal_scope: "selected_text",
    proposal_source: "First paragraph.",
    proposal_replacement: "Rewritten first paragraph."
  });
  assert.equal(proposal.proposed_markdown, "# Title\n\nRewritten first paragraph.\n\nSecond paragraph.");
  assert.equal(proposal.source, "First paragraph.");
  assert.equal(proposal.replacement, "Rewritten first paragraph.");
});

test("selected proposal rejects ambiguous source", () => {
  assert.throws(() => buildNotionEditProposal({ ...PAGE, markdown:"same\n\nsame" }, {
    proposal_scope: "selected_blocks",
    proposal_source: "same",
    proposal_replacement: "new"
  }), /exactly once/);
});

test("line diff aligns unchanged rows and changed rows side by side", () => {
  const rows = buildSideBySideLineDiff("a\nb\nc", "a\nB\nc\nd");
  assert.deepEqual(rows[0], { type:"equal", left_line:1, right_line:1, left:"a", right:"a" });
  assert.ok(rows.some((row) => row.type === "change" && row.left === "b" && row.right === "B"));
  assert.ok(rows.some((row) => row.type === "add" && row.right === "d"));
});
