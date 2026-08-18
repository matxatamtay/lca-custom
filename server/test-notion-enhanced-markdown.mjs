// Notion Enhanced Markdown renderer/parser regression tests
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { parseNotionEnhancedMarkdown } from "./notion-enhanced-markdown.mjs";

const LIVE_SAMPLE = `👋 Welcome to Notion!
<empty-block/>
Here are the basics:
- [ ] Tap anywhere and start typing
- [ ] Tap the + above your keyboard to add content — headers, sub pages, etc.
\t<page url="https://app.notion.com/p/8dbd4f3a6ee14dee8a27b62ae255476b">Example sub page</page>
- [ ] Highlight text and use the bar above your keyboard to format
- [ ] Tap and hold this line, then drag
- [ ] Tap the home tab button at the bottom left to see your pages
<empty-block/>
👉 **Have a question? **Tap \`Help & feedback\` in the sidebar. {color="gray"}

<page url="https://app.notion.com/p/3b66511e13c281768718dc77634452f8">LCA Live Test 2026-08-08 14:15:24</page>`;

test("parses the live Getting Started page without exposing Notion control markup as text blocks", () => {
  const blocks = parseNotionEnhancedMarkdown(LIVE_SAMPLE);
  assert.equal(blocks[0].kind, "text");
  assert.equal(blocks[1].kind, "empty");
  assert.equal(blocks.filter((block) => block.kind === "todo").length, 5);

  const subpage = blocks.find((block) => block.kind === "pageRef" && block.text === "Example sub page");
  assert.ok(subpage);
  assert.equal(subpage.indent, 1);
  assert.match(subpage.url, /8dbd4f3a6ee14dee8a27b62ae255476b$/);

  const grayText = blocks.find((block) => block.kind === "text" && block.text.includes("Have a question"));
  assert.ok(grayText);
  assert.equal(grayText.color, "gray");
  assert.doesNotMatch(grayText.text, /\{color=/);

  assert.equal(blocks.filter((block) => block.kind === "empty").length, 2);
  assert.equal(blocks.at(-1).kind, "pageRef");
  assert.ok(blocks.every((block) => !String(block.text || "").includes("<empty-block")));
});

test("parses Notion structural enhanced-Markdown blocks", () => {
  const markdown = `<callout icon="💡" color="yellow_bg">
Hello **world**
</callout>
<details>
<summary>More</summary>
- [x] Done
</details>
<columns>
<column>
Left
</column>
<column>
Right
</column>
</columns>
<table header-row="true">
| Name | Value |
| --- | --- |
| A | 1 |
</table>
\`\`\`js
console.log("ok")
\`\`\`
$$
x^2
$$`;

  const blocks = parseNotionEnhancedMarkdown(markdown);
  assert.equal(blocks[0].kind, "callout");
  assert.equal(blocks[0].icon, "💡");
  assert.equal(blocks[0].color, "yellow_bg");
  assert.equal(blocks[0].children[0].text, "Hello **world**");

  assert.equal(blocks[1].kind, "toggle");
  assert.equal(blocks[1].summary, "More");
  assert.equal(blocks[1].children[0].kind, "todo");
  assert.equal(blocks[1].children[0].checked, true);

  assert.equal(blocks[2].kind, "columns");
  assert.equal(blocks[2].columns.length, 2);
  assert.equal(blocks[2].columns[0][0].text, "Left");

  assert.equal(blocks[3].kind, "table");
  assert.equal(blocks[3].headerRow, true);
  assert.deepEqual(blocks[3].rows[0], ["Name", "Value"]);
  assert.deepEqual(blocks[3].rows[1], ["A", "1"]);

  assert.equal(blocks[4].kind, "code");
  assert.equal(blocks[4].language, "js");
  assert.equal(blocks[5].kind, "equation");
});
