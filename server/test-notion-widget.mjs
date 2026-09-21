// Notion Apps SDK widget regression tests
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const widgetPath = new URL("./notion-page.html", import.meta.url);
const templatePath = new URL("./notion-page.template.html", import.meta.url);
const rendererPath = new URL("./notion-react-renderer.tsx", import.meta.url);
const packagePath = new URL("./package.json", import.meta.url);
const serverPath = new URL("./server.mjs", import.meta.url);
const toolsPath = new URL("./notion-tools.mjs", import.meta.url);
const inputPath = new URL("./lca-compact-input-v2.html", import.meta.url);

test("Notion widget bundles react-notion-x while preserving LCA safety and ChatGPT bridges", async () => {
  const [html, template, renderer, packageText, server, tools] = await Promise.all([
    readFile(widgetPath, "utf8"),
    readFile(templatePath, "utf8"),
    readFile(rendererPath, "utf8"),
    readFile(packagePath, "utf8"),
    readFile(serverPath, "utf8"),
    readFile(toolsPath, "utf8")
  ]);
  const pkg = JSON.parse(packageText);

  assert.ok(pkg.dependencies?.["react-notion-x"], "react-notion-x dependency must be installed");
  assert.ok(pkg.dependencies?.["notion-compat"], "notion-compat adapter dependency must be installed");
  assert.ok(pkg.scripts?.["build:notion-widget"]?.includes("build-notion-widget.mjs"));
  assert.match(renderer, /NotionRenderer/);
  assert.match(renderer, /convertPage/);
  assert.match(renderer, /LcaNotionX/);
  assert.match(renderer, /mountPage/);
  assert.match(renderer, /fullPage=\{true\}/);
  assert.doesNotMatch(renderer, /function mountBlock/);
  assert.match(renderer, /className="notion-code"/);
  assert.match(renderer, /className="notion-equation"/);
  assert.match(template, /\/\*__REACT_NOTION_X_CSS__\*\//);
  assert.match(template, /\/\*__REACT_NOTION_X_BUNDLE__\*\//);
  assert.doesNotMatch(html, /__REACT_NOTION_X_(?:CSS|BUNDLE)__/);
  assert.match(html, /LcaNotionX/);

  for (const [key, id] of [
    ["shell", "shell"],
    ["sidebar", "sidebar"],
    ["sidebarToggle", "sidebar-toggle"],
    ["scrim", "scrim"],
    ["searchBtn", "search-btn"],
    ["refreshBtn", "refresh-btn"],
    ["floatBtn", "float-btn"],
    ["fullscreenBtn", "fullscreen-btn"],
    ["openBtn", "open-btn"],
    ["editBtn", "edit-btn"],
    ["saveBtn", "save-btn"],
    ["cancelBtn", "cancel-btn"],
    ["proposalComposer", "proposal-composer"],
    ["proposalScope", "proposal-scope"],
    ["proposalPrompt", "proposal-prompt"],
    ["proposalGenerate", "proposal-generate"],
    ["proposalReview", "proposal-review"],
    ["proposalLeft", "proposal-left"],
    ["proposalRight", "proposal-right"],
    ["proposalApply", "proposal-apply"],
    ["proposalReject", "proposal-reject"],
    ["proposalRevise", "proposal-revise"],
    ["addPage", "add-page"],
    ["addBlocks", "add-blocks"],
    ["addSelection", "add-selection"],
    ["addMeta", "add-meta"],
    ["proposeBtn", "propose-btn"],
    ["askBtn", "ask-btn"],
    ["chatPanel", "chat-panel"],
    ["chatMessages", "chat-messages"],
    ["chatInput", "chat-input"],
    ["chatSend", "chat-send"]
  ]) {
    assert.match(template, new RegExp(`\\[\\"${key}\\", \\"${id}\\"\\]`));
  }

  assert.match(template, /grid-template-columns:220px minmax\(0,1fr\) minmax\(320px,380px\)/);
  assert.match(template, /body\[data-display-mode="fullscreen"\] \{ height:100vh; padding:0; overflow:hidden/);
  assert.match(template, /body\[data-display-mode="fullscreen"\] \.shell \{ height:100vh; min-height:0; max-height:none/);
  assert.match(template, /\.scroll \{ flex:1; min-height:0; overflow-x:hidden; overflow-y:auto/);
  assert.match(template, /class="chat-panel"/);
  assert.match(template, /class="chat-messages"/);
  assert.match(template, /class="chat-composer"/);
  assert.match(template, /function sendChatMessage\(\)/);
  assert.match(template, /You may use any available ChatGPT\/LCA tool needed/);
  assert.match(template, /window\.openai\.sendFollowUpMessage/);
  assert.match(template, /notionModel\(currentPage\)/);
  assert.match(template, /mountReactNotionPage/);
  assert.match(template, /react-notion-page-active/);
  assert.match(template, /toggleRenderedBlockSelection/);
  assert.match(template, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(template, /include_render_data:true/);
  assert.match(template, /const pageCache = new Map\(\)/);
  assert.match(template, /const pageInflight = new Map\(\)/);
  assert.match(template, /PRELOAD_CONCURRENCY = 2/);
  assert.match(template, /function preloadListedPages/);
  assert.match(template, /preloadListedPages\(listedPages\)/);
  assert.match(template, /data-preload-state/);
  assert.match(template, /loadPage\(currentPage\.id, \{ force:true \}\)/);
  assert.match(template, /async function hydrate/);
  assert.match(server, /compactNotionWidgetPage/);
  assert.match(tools, /include_render_data/);
  assert.match(tools, /includeRenderData: include_render_data/);
  assert.doesNotMatch(template, /\.viewer\.react-notion-page > \.notion \{[^}]*background:var\(--bg\)[^}]*color:var\(--text\)/s);
  assert.match(template, /window\.addEventListener\("lca:notion-page-link"/);

  const topbar = template.indexOf('<header class="topbar">');
  const topActions = template.indexOf('id="context-menu"');
  const pageScroll = template.indexOf('<div class="scroll">');
  assert.ok(topbar >= 0 && topActions > topbar && topActions < pageScroll, "all Notion action buttons should live in the top toolbar");

  assert.match(template, /window\.openai\.callTool\("notion"/);
  assert.match(template, /callUiRpc\("tools\/call", \{ name:"notion"/);
  assert.match(template, /ui\/update-model-context/);
  assert.match(template, /setWidgetState/);
  assert.match(template, /requestDisplayMode/);
  assert.match(template, /requestDisplayMode\(\{ mode:"pip" \}\)/);
  assert.match(template, /openExternal/);
  assert.match(template, /expected_last_edited_time/);
  assert.match(template, /expected_markdown_sha256/);
  assert.match(template, /hasIncompleteMarkdown/);
  assert.match(template, /untrusted reference data/);
  assert.match(template, /Staged preview/);
  assert.match(template, /Side by side/);
  assert.match(template, /Generate preview/);
  assert.match(template, /Apply to Notion/);
  assert.match(template, /Proposal rejected · Notion was not changed/);
  assert.match(template, /Do not call notion update, replace, create, or generic mutation actions/);
  assert.match(template, /target\.scrollTop = source\.scrollTop/);
  assert.match(template, /allow_deleting_content:true/);
  assert.match(template, /currentProposal\.base_markdown_sha256/);
  assert.match(template, /Selected blocks must be contiguous/);
  assert.match(template, /row\.dataset\.blockText = block\.raw \|\| block\.text \|\| ""/);
  assert.doesNotMatch(template, /NOTION_API_KEY/);
  assert.doesNotMatch(html, /NOTION_API_KEY/);
});

test("lca-input exposes lazy @notion page references", async () => {
  const html = await readFile(inputPath, "utf8");
  assert.match(html, /normalizedQuery\.startsWith\('notion:'\)/);
  assert.match(html, /action: 'search'/);
  assert.match(html, /mention: `notion:\$\{page\.id\}`/);
  assert.match(html, /Notion context references/);
  assert.match(html, /untrusted reference data/);
  assert.match(html, /action=fetch/);
});
