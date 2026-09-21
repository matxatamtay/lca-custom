// Local Coding Agent — Notion MCP tool registration
// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";

import {
  notionCall,
  notionCreatePage,
  notionFetchPage,
  notionReplaceMarkdown,
  notionSearch,
  notionStatus,
  notionUpdateMarkdown
} from "./notion-api.mjs";

export function registerNotionTools(mcp, dependencies) {
  const { registerTool, jsonResult, apiOptions, apiVersion } = dependencies;
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true };
  const mutation = { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false };

  registerTool(mcp, "notion_status", {
    title: "Notion status",
    description: "Validate the configured Notion bearer token without exposing it.",
    annotations: readOnly,
    inputSchema: {}
  }, async () => jsonResult(await notionStatus(apiOptions)));

  registerTool(mcp, "notion_capabilities", {
    title: "Notion capabilities",
    description: "List the stable LCA Notion actions and the configured API version.",
    annotations: readOnly,
    inputSchema: {}
  }, async () => jsonResult({
    api_version: apiVersion,
    actions: ["status", "search", "fetch", "create", "update", "replace", "call"],
    widget: "notion_page",
    credential_env: "NOTION_API_KEY"
  }));

  registerTool(mcp, "notion_search", {
    title: "Search Notion pages",
    description: "Search pages shared with the configured Notion connection, sorted by most recently edited.",
    annotations: readOnly,
    inputSchema: {
      query: z.string().optional(),
      page_size: z.number().int().min(1).max(100).optional(),
      start_cursor: z.string().optional()
    }
  }, async (args) => jsonResult(await notionSearch(args, apiOptions)));

  registerTool(mcp, "notion_fetch_page", {
    title: "Fetch Notion page",
    description: "Retrieve Notion page metadata plus the enhanced-Markdown representation available to the connection.",
    annotations: readOnly,
    inputSchema: {
      page_id: z.string().min(1).optional(),
      page_url: z.string().min(1).optional(),
      include_render_data: z.boolean().optional().describe("Widget-only: include the raw Notion block graph used by react-notion-x. Leave false for normal model reads.")
    }
  }, async ({ page_id, page_url, include_render_data = false }) => {
    const page = await notionFetchPage(page_id || page_url, {
      ...apiOptions,
      includeRenderData: include_render_data
    });
    if (include_render_data) return jsonResult(page);
    const { render_data: _renderData, ...compactPage } = page;
    return jsonResult(compactPage);
  });

  registerTool(mcp, "notion_create_page", {
    title: "Create Notion page",
    description: "Create a Notion page using a raw Notion page-create body, with optional enhanced Markdown applied after creation.",
    annotations: mutation,
    inputSchema: {
      body: z.record(z.any()),
      markdown: z.string().optional()
    }
  }, async (args) => jsonResult(await notionCreatePage(args, apiOptions)));

  registerTool(mcp, "notion_update_markdown", {
    title: "Update Notion Markdown",
    description: "Apply an explicitly approved targeted Enhanced-Markdown edit with revision guards. For AI-generated rewrites, do NOT call this before a staged notion_page proposal has been previewed and approved in the widget.",
    annotations: mutation,
    inputSchema: {
      page_id: z.string().min(1).optional(),
      page_url: z.string().min(1).optional(),
      expected_last_edited_time: z.string().optional(),
      expected_markdown_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
      content_updates: z.array(z.object({
        old_str: z.string(),
        new_str: z.string(),
        replace_all_matches: z.boolean().optional()
      })).min(1),
      allow_deleting_content: z.boolean().optional()
    }
  }, async (args) => jsonResult(await notionUpdateMarkdown(args, apiOptions)));

  registerTool(mcp, "notion_replace_markdown", {
    title: "Replace Notion Markdown",
    description: "Apply an explicitly approved full-page Enhanced-Markdown replacement with revision guards. For AI-generated rewrites, do NOT call this before a staged notion_page proposal has been previewed and approved in the widget.",
    annotations: mutation,
    inputSchema: {
      page_id: z.string().min(1).optional(),
      page_url: z.string().min(1).optional(),
      markdown: z.string(),
      expected_last_edited_time: z.string().optional(),
      expected_markdown_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
      allow_deleting_content: z.boolean().optional()
    }
  }, async (args) => jsonResult(await notionReplaceMarkdown(args, apiOptions)));

  registerTool(mcp, "notion_call", {
    title: "Call Notion API",
    description: "Call an allowed relative Notion API path for forward-compatible operations. Arbitrary external URLs are rejected.",
    annotations: mutation,
    inputSchema: {
      method: z.enum(["GET", "POST", "PATCH", "DELETE"]).optional(),
      path: z.string().min(1),
      query: z.record(z.any()).optional(),
      body: z.any().optional()
    }
  }, async (args) => jsonResult(await notionCall(args, apiOptions)));
}
