// Local Coding Agent — Notion REST API integration
// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseNotionEnhancedMarkdown } from "./notion-enhanced-markdown.mjs";
import { notionMarkdownSha256 } from "./notion-edit-proposal.mjs";

export const DEFAULT_NOTION_API_BASE = "https://api.notion.com/v1";
export const DEFAULT_NOTION_VERSION = "2026-03-11";

const SAFE_PATH = /^(?:users(?:\/|$)|search$|pages(?:\/|$)|blocks(?:\/|$)|comments(?:\/|$)|databases(?:\/|$)|data_sources(?:\/|$)|views(?:\/|$)|file_uploads(?:\/|$)|custom_emoji(?:\/|$))/;

export async function notionStatus(options = {}) {
  const token = notionToken(options);
  const apiBase = notionApiBase(options);
  const version = notionVersion(options);
  if (!token) {
    return {
      connected: false,
      auth_configured: false,
      api_base: apiBase,
      api_version: version,
      error: "Notion is not configured. Set NOTION_API_KEY in the LCA TUI, then restart LCA."
    };
  }
  try {
    const user = await notionRequest("GET", "users/me", { ...options, token });
    return {
      connected: true,
      auth_configured: true,
      api_base: apiBase,
      api_version: version,
      user: normalizeUser(user)
    };
  } catch (error) {
    return {
      connected: false,
      auth_configured: true,
      api_base: apiBase,
      api_version: version,
      error: friendlyNotionError(error)
    };
  }
}

export async function notionSearch(input = {}, options = {}) {
  const query = String(input.query ?? "").trim();
  const body = {
    ...(query ? { query } : {}),
    filter: { property: "object", value: "page" },
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: clamp(Number(input.page_size) || 20, 1, 100),
    ...(input.start_cursor ? { start_cursor: String(input.start_cursor) } : {})
  };
  const result = await notionRequest("POST", "search", { ...options, body });
  return {
    query,
    results: (result.results || []).filter((item) => item?.object === "page").map(normalizePageSummary),
    has_more: Boolean(result.has_more),
    next_cursor: result.next_cursor || null
  };
}

export async function notionFetchPage(pageReference, options = {}) {
  const pageId = normalizeNotionPageId(pageReference);
  const [page, markdown] = await Promise.all([
    notionRequest("GET", `pages/${pageId}`, options),
    notionRequest("GET", `pages/${pageId}/markdown`, options)
  ]);
  const renderData = options.includeRenderData === false
    ? undefined
    : await fetchNotionRenderData(page, options).catch(() => null);
  const markdownText = String(markdown?.markdown || "");
  return {
    ...normalizePageSummary(page),
    markdown: markdownText,
    markdown_sha256: notionMarkdownSha256(markdownText),
    render_blocks: parseNotionEnhancedMarkdown(markdownText),
    ...(renderData !== undefined ? { render_data: renderData } : {}),
    truncated: Boolean(markdown?.truncated),
    unknown_block_ids: Array.isArray(markdown?.unknown_block_ids) ? markdown.unknown_block_ids : []
  };
}

export async function notionReplaceMarkdown(input, options = {}) {
  const pageId = normalizeNotionPageId(input.page_id || input.page_url);
  await assertExpectedPageState(pageId, input, options);
  await notionRequest("PATCH", `pages/${pageId}/markdown`, {
    ...options,
    body: {
      type: "replace_content",
      replace_content: {
        new_str: String(input.markdown ?? ""),
        allow_deleting_content: input.allow_deleting_content === true
      },
      allow_async: false
    }
  });
  return notionFetchPage(pageId, options);
}

async function fetchNotionRenderData(rootPage, options) {
  const pageId = normalizeNotionPageId(rootPage?.id);
  const blockMap = {};
  const blockChildrenMap = {};
  const parentMap = {};
  const pageMap = { [pageId]: rootPage };
  const visited = new Set();
  const limit = createAsyncLimiter(4);

  const listChildren = async (blockId) => {
    const results = [];
    let cursor = null;
    do {
      const response = await notionRequest("GET", `blocks/${blockId}/children`, {
        ...options,
        query: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }
      });
      results.push(...(Array.isArray(response?.results) ? response.results : []));
      cursor = response?.has_more ? response.next_cursor || null : null;
    } while (cursor);
    return results;
  };

  const visit = async (parentId) => {
    if (visited.has(parentId)) return;
    visited.add(parentId);
    const children = await limit(() => listChildren(parentId));
    blockChildrenMap[parentId] = children.map((block) => block.id).filter(Boolean);
    const nested = [];
    for (const block of children) {
      if (!block?.id) continue;
      blockMap[block.id] = block;
      parentMap[block.id] = parentId;
      if (block.type === "child_page") {
        nested.push(limit(async () => {
          try { pageMap[block.id] = await notionRequest("GET", `pages/${block.id}`, options); } catch {}
        }));
        continue;
      }
      if (block.type === "child_database") continue;
      if (block.has_children) nested.push(visit(block.id));
    }
    await Promise.all(nested);
  };

  await visit(pageId);
  return {
    page_id: pageId,
    block_map: blockMap,
    block_children_map: blockChildrenMap,
    parent_map: parentMap,
    page_map: pageMap
  };
}

function createAsyncLimiter(maxConcurrency) {
  const limit = Math.max(1, Number(maxConcurrency) || 1);
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < limit && queue.length) {
      const item = queue.shift();
      active += 1;
      Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => { active -= 1; drain(); });
    }
  };
  return (task) => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); drain(); });
}

export async function notionUpdateMarkdown(input, options = {}) {
  const pageId = normalizeNotionPageId(input.page_id || input.page_url);
  await assertExpectedPageState(pageId, input, options);
  const updates = Array.isArray(input.content_updates) ? input.content_updates : [];
  if (!updates.length) throw new Error("Notion update requires at least one content update.");
  return notionRequest("PATCH", `pages/${pageId}/markdown`, {
    ...options,
    body: {
      type: "update_content",
      update_content: {
        content_updates: updates.map((update) => ({
          old_str: String(update.old_str ?? ""),
          new_str: String(update.new_str ?? ""),
          ...(update.replace_all_matches === true ? { replace_all_matches: true } : {})
        })),
        allow_deleting_content: input.allow_deleting_content === true
      },
      allow_async: false
    }
  });
}

export async function notionCreatePage(input, options = {}) {
  const body = input?.body && typeof input.body === "object" ? input.body : input;
  const page = await notionRequest("POST", "pages", { ...options, body });
  if (typeof input?.markdown === "string") {
    return notionReplaceMarkdown({ page_id: page.id, markdown: input.markdown }, options);
  }
  return normalizePageSummary(page);
}

export async function notionCall(input, options = {}) {
  const method = String(input.method || "GET").toUpperCase();
  if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) throw new Error(`Unsupported Notion method: ${method}`);
  const path = normalizeSafePath(input.path);
  return notionRequest(method, path, { ...options, body: input.body, query: input.query });
}

export async function notionRequest(method, path, options = {}) {
  const token = notionToken(options);
  if (!token) throw new Error("Notion API key is missing. Set NOTION_API_KEY in the LCA TUI and restart LCA.");
  const fetchImpl = options.fetchImpl || fetch;
  const url = new URL(`${notionApiBase(options)}/${String(path).replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": notionVersion(options),
    ...(options.body !== undefined ? { "Content-Type": "application/json" } : {})
  };
  const request = {
    method,
    headers,
    signal: AbortSignal.timeout(clamp(Number(options.timeoutMs) || 30_000, 1_000, 120_000)),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
  };
  let response = await fetchImpl(url, request);
  if (response.status === 429) {
    const retryAfter = clamp(Number(response.headers?.get?.("retry-after")) || 1, 1, 5);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    response = await fetchImpl(url, request);
  }
  const text = await response.text();
  const payload = parsePayload(text);
  if (!response.ok) {
    const message = payload?.message || payload?.error || text || `HTTP ${response.status}`;
    const error = new Error(`Notion API ${response.status}: ${message}`);
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  return payload;
}

export function normalizeNotionPageId(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Notion page id or URL is required.");
  let candidate = raw;
  try {
    const url = new URL(raw);
    candidate = url.pathname.split("/").filter(Boolean).at(-1) || raw;
  } catch {}
  const compact = candidate.split("?")[0].split("#")[0].match(/[0-9a-f]{32}$/i)?.[0] || candidate.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(compact)) throw new Error(`Invalid Notion page id or URL: ${raw}`);
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`.toLowerCase();
}

export function normalizePageSummary(page = {}) {
  return {
    id: page.id || null,
    title: notionPageTitle(page),
    url: page.url || null,
    icon: page.icon?.emoji || null,
    created_time: page.created_time || null,
    last_edited_time: page.last_edited_time || null,
    parent: page.parent || null,
    properties: page.properties || {},
    in_trash: Boolean(page.in_trash || page.archived)
  };
}

function notionPageTitle(page) {
  for (const property of Object.values(page?.properties || {})) {
    const title = property?.type === "title" ? property.title : property?.title;
    if (Array.isArray(title) && title.length) return title.map((part) => part?.plain_text || part?.text?.content || "").join("") || "Untitled";
  }
  return "Untitled";
}

async function assertExpectedPageState(pageId, input, options) {
  const expectedEditTime = String(input?.expected_last_edited_time || "").trim();
  const expectedMarkdownSha256 = String(input?.expected_markdown_sha256 || "").trim().toLowerCase();
  if (!expectedEditTime && !expectedMarkdownSha256) return;

  const [page, markdown] = await Promise.all([
    expectedEditTime ? notionRequest("GET", `pages/${pageId}`, options) : Promise.resolve(null),
    expectedMarkdownSha256 ? notionRequest("GET", `pages/${pageId}/markdown`, options) : Promise.resolve(null)
  ]);
  if (expectedEditTime && page?.last_edited_time && page.last_edited_time !== expectedEditTime) {
    const error = new Error(`Notion conflict: page changed remotely at ${page.last_edited_time}. Reload before saving.`);
    error.code = "notion_conflict";
    error.current_last_edited_time = page.last_edited_time;
    throw error;
  }
  if (expectedMarkdownSha256) {
    const currentMarkdown = String(markdown?.markdown || "");
    const currentSha256 = notionMarkdownSha256(currentMarkdown);
    if (currentSha256 !== expectedMarkdownSha256) {
      const error = new Error("Notion conflict: page content changed since this preview was created. Reload and regenerate the proposal before applying.");
      error.code = "notion_conflict";
      error.current_markdown_sha256 = currentSha256;
      throw error;
    }
  }
}

function normalizeSafePath(value) {
  const path = String(value || "").trim().replace(/^\/+/, "");
  if (!path || !SAFE_PATH.test(path)) throw new Error("Notion call path is not allowed.");
  return path;
}

function normalizeUser(user = {}) {
  return { id: user.id || null, name: user.name || null, type: user.type || null, bot: user.bot ? { owner: user.bot.owner || null } : null };
}

function notionToken(options) { return String(options.token ?? process.env.NOTION_API_KEY ?? "").trim(); }
function notionApiBase(options) { return String(options.apiBase ?? process.env.NOTION_API_BASE ?? DEFAULT_NOTION_API_BASE).replace(/\/$/, ""); }
function notionVersion(options) { return String(options.version ?? process.env.NOTION_VERSION ?? DEFAULT_NOTION_VERSION).trim() || DEFAULT_NOTION_VERSION; }
function parsePayload(text) { if (!text) return {}; try { return JSON.parse(text); } catch { return { text }; } }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function friendlyNotionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|unauthorized/i.test(message)) return "Notion rejected the API key. Update NOTION_API_KEY in the LCA TUI and restart LCA.";
  if (/403|restricted_resource|forbidden/i.test(message)) return "Notion denied access. Share the target pages with the connection and enable the required content capabilities.";
  return message;
}
