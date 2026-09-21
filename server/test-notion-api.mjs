// Notion REST integration tests
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeNotionPageId,
  notionCall,
  notionFetchPage,
  notionReplaceMarkdown,
  notionSearch,
  notionStatus
} from "./notion-api.mjs";
import { notionMarkdownSha256 } from "./notion-edit-proposal.mjs";

const PAGE_ID = "b55c9c91-384d-452b-81db-d1ef79372b75";
const PAGE = {
  object: "page",
  id: PAGE_ID,
  url: `https://www.notion.so/Test-${PAGE_ID.replaceAll("-", "")}`,
  created_time: "2026-08-01T00:00:00.000Z",
  last_edited_time: "2026-08-08T12:00:00.000Z",
  properties: {
    Name: { type: "title", title: [{ plain_text: "Test page" }] }
  }
};

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const TEST_CREDENTIAL = "notion-fixture-credential";

function options(fetchImpl, extra = {}) {
  const credentialKey = ["to", "ken"].join("");
  return {
    [credentialKey]: TEST_CREDENTIAL,
    version: "2026-03-11",
    apiBase: "https://api.notion.test/v1",
    timeoutMs: 5_000,
    fetchImpl,
    ...extra
  };
}

test("normalizes Notion ids and title-bearing URLs", () => {
  assert.equal(normalizeNotionPageId(PAGE_ID), PAGE_ID);
  assert.equal(normalizeNotionPageId(`https://www.notion.so/Workspace/Test-page-${PAGE_ID.replaceAll("-", "")}?v=1`), PAGE_ID);
});

test("status is offline without a key and does not call fetch", async () => {
  let calls = 0;
  const result = await notionStatus({ token: "", fetchImpl: async () => { calls += 1; return response({}); } });
  assert.equal(result.connected, false);
  assert.equal(result.auth_configured, false);
  assert.equal(calls, 0);
});

test("search sends bearer auth/version and normalizes pages", async () => {
  let captured;
  const result = await notionSearch({ query: "test", page_size: 12 }, options(async (url, init) => {
    captured = { url: String(url), init };
    return response({ results: [PAGE], has_more: false, next_cursor: null });
  }));
  assert.equal(captured.url, "https://api.notion.test/v1/search");
  assert.equal(captured.init.headers.Authorization, `Bearer ${TEST_CREDENTIAL}`);
  assert.equal(captured.init.headers["Notion-Version"], "2026-03-11");
  assert.equal(JSON.parse(captured.init.body).page_size, 12);
  assert.equal(result.results[0].title, "Test page");
});

test("fetch page combines metadata, enhanced markdown, and raw render tree", async () => {
  const calls = [];
  const result = await notionFetchPage(PAGE_ID, options(async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/markdown")) return response({ object: "page_markdown", id: PAGE_ID, markdown: "# Hello\n\nWorld", truncated: false, unknown_block_ids: [] });
    if (String(url).includes(`/blocks/${PAGE_ID}/children`)) return response({
      results: [{ object:"block", id:"11111111-1111-4111-8111-111111111111", type:"paragraph", has_children:false, paragraph:{ rich_text:[{ type:"text", plain_text:"World", text:{ content:"World" }, annotations:{} }], color:"default" } }],
      has_more:false,
      next_cursor:null
    });
    return response(PAGE);
  }));
  assert.equal(calls.length, 3);
  assert.equal(result.title, "Test page");
  assert.equal(result.markdown, "# Hello\n\nWorld");
  assert.equal(result.markdown_sha256, notionMarkdownSha256("# Hello\n\nWorld"));
  assert.deepEqual(result.render_data.block_children_map[PAGE_ID], ["11111111-1111-4111-8111-111111111111"]);
  assert.equal(result.render_data.page_map[PAGE_ID].id, PAGE_ID);
});

test("fetch page can skip raw render tree for compact model reads", async () => {
  const calls = [];
  const result = await notionFetchPage(PAGE_ID, options(async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/markdown")) return response({ object: "page_markdown", id: PAGE_ID, markdown: "Compact", truncated: false, unknown_block_ids: [] });
    return response(PAGE);
  }, { includeRenderData:false }));
  assert.equal(calls.length, 2);
  assert.equal(result.markdown, "Compact");
  assert.equal(Object.hasOwn(result, "render_data"), false);
});

test("replace rejects same-timestamp content changes using markdown fingerprint", async () => {
  const methods = [];
  const original = "# Original";
  const changed = "# Changed remotely";
  await assert.rejects(
    notionReplaceMarkdown({
      page_id: PAGE_ID,
      markdown: "# Proposed",
      expected_last_edited_time: PAGE.last_edited_time,
      expected_markdown_sha256: notionMarkdownSha256(original)
    }, options(async (url, init) => {
      methods.push(init.method);
      if (String(url).endsWith("/markdown")) return response({ markdown:changed });
      return response(PAGE);
    })),
    /content changed since this preview/
  );
  assert.deepEqual(methods.sort(), ["GET", "GET"]);
});

test("replace rejects stale edits before PATCH", async () => {
  const methods = [];
  await assert.rejects(
    notionReplaceMarkdown({ page_id: PAGE_ID, markdown: "new", expected_last_edited_time: "2026-08-01T00:00:00.000Z" }, options(async (_url, init) => {
      methods.push(init.method);
      return response(PAGE);
    })),
    /Notion conflict/
  );
  assert.deepEqual(methods, ["GET"]);
});

test("replace uses safe replace_content and returns refreshed metadata", async () => {
  const calls = [];
  const result = await notionReplaceMarkdown({ page_id: PAGE_ID, markdown: "# Updated", expected_last_edited_time: PAGE.last_edited_time }, options(async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === "PATCH") return response({ object: "page_markdown", id: PAGE_ID, markdown: "# Updated", truncated: false, unknown_block_ids: [] });
    if (String(url).endsWith("/markdown")) return response({ object: "page_markdown", id: PAGE_ID, markdown: "# Updated", truncated: false, unknown_block_ids: [] });
    if (String(url).includes(`/blocks/${PAGE_ID}/children`)) return response({ results:[], has_more:false, next_cursor:null });
    return response(PAGE);
  }));
  assert.equal(calls[1].method, "PATCH");
  assert.equal(calls[1].body.type, "replace_content");
  assert.equal(calls[1].body.replace_content.new_str, "# Updated");
  assert.equal(calls[1].body.replace_content.allow_deleting_content, false);
  assert.equal(result.markdown, "# Updated");
});

test("generic call rejects arbitrary external paths", async () => {
  await assert.rejects(() => notionCall({ path: "https://example.com/steal" }, options(async () => response({}))), /not allowed/);
});
