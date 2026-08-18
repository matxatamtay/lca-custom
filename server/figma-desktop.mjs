// Local Coding Agent — Figma Desktop MCP bridge
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { pathToFileURL } from "node:url";
import {
  PersistentHttpMcpClient,
  PersistentHttpMcpClientRegistry,
  normalizeTimeout,
  persistentHttpClientKey
} from "./persistent-http-mcp-client.mjs";

export const DEFAULT_FIGMA_DESKTOP_MCP_URL = "http://127.0.0.1:3845/mcp";
const DEFAULT_TIMEOUT_MS = 30_000;

export function normalizeFigmaDesktopEndpoint(value = process.env.FIGMA_DESKTOP_MCP_URL || DEFAULT_FIGMA_DESKTOP_MCP_URL) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_FIGMA_DESKTOP_MCP_URL).trim());
  } catch {
    throw new Error("FIGMA_DESKTOP_MCP_URL must be a valid HTTP URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("FIGMA_DESKTOP_MCP_URL must use http or https.");
  }
  return url.toString();
}

export function parseFigmaNodeReference(value) {
  const raw = String(value || "").trim();
  if (!raw) return { nodeId: "", fileKey: "", url: "" };
  if (!/^https?:\/\//i.test(raw)) {
    return {
      nodeId: /^\d+-\d+$/.test(raw) ? raw.replace("-", ":") : raw,
      fileKey: "",
      url: ""
    };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid Figma URL.");
  }
  if (!/(^|\.)figma\.com$/i.test(url.hostname)) {
    throw new Error("Only figma.com URLs are accepted as Figma references.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const typeIndex = parts.findIndex((part) => ["design", "file", "board", "proto", "make"].includes(part.toLowerCase()));
  const fileKey = typeIndex >= 0 ? String(parts[typeIndex + 1] || "") : "";
  const rawNodeId = decodeURIComponent(url.searchParams.get("node-id") || "").trim();
  const nodeId = /^\d+-\d+$/.test(rawNodeId) ? rawNodeId.replace("-", ":") : rawNodeId;
  return { nodeId, fileKey, url: url.toString() };
}

const figmaClients = new PersistentHttpMcpClientRegistry();

export function friendlyFigmaDesktopError(error, endpoint = normalizeFigmaDesktopEndpoint()) {
  const message = String(error?.cause?.message || error?.message || error || "Unknown error");
  if (/ECONNREFUSED|fetch failed|Failed to open SSE stream/i.test(message)) {
    return new Error(
      `Figma Desktop MCP is not running at ${endpoint}. Open the Figma desktop app, open a Design file, switch to Dev Mode, then click "Enable desktop MCP server" in the MCP server section.`
    );
  }
  return new Error(`Figma Desktop MCP error: ${message}`);
}

function getFigmaDesktopClient(options = {}) {
  const endpoint = normalizeFigmaDesktopEndpoint(options.endpoint);
  const ms = normalizeTimeout(options.timeoutMs ?? process.env.FIGMA_DESKTOP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const clientName = options.clientName || "local-coding-agent-figma-bridge";
  const key = `${persistentHttpClientKey({ endpoint, clientName })}|timeout=${ms}`;
  return figmaClients.get(key, () => new PersistentHttpMcpClient({
    endpoint,
    clientName,
    clientVersion: "1.0.0",
    timeoutMs: ms,
    mapError: (error) => friendlyFigmaDesktopError(error, endpoint)
  }));
}

export async function withFigmaDesktopClient(callback, options = {}) {
  return callback(getFigmaDesktopClient(options));
}

export async function closeFigmaDesktopClients() {
  await figmaClients.closeAll();
}

export async function listFigmaDesktopTools(options = {}) {
  return getFigmaDesktopClient(options).listTools({ refresh: options.refresh === true });
}

export async function callFigmaDesktopTool(name, args = {}, options = {}) {
  const toolName = String(name || "").trim();
  if (!toolName) throw new Error("Figma tool name is required.");
  const client = getFigmaDesktopClient(options);
  const { listed, tool } = await client.findTool(toolName);
  if (!tool) {
    throw new Error(`Figma Desktop does not expose tool "${toolName}". Available: ${listed.tools.map((item) => item.name).join(", ") || "none"}`);
  }
  return client.callTool({ name: toolName, arguments: args || {} });
}

export async function figmaDesktopStatus(options = {}) {
  let endpoint = String(options.endpoint || process.env.FIGMA_DESKTOP_MCP_URL || DEFAULT_FIGMA_DESKTOP_MCP_URL);
  try {
    endpoint = normalizeFigmaDesktopEndpoint(endpoint);
    const listed = await listFigmaDesktopTools({ ...options, endpoint });
    return {
      connected: true,
      endpoint,
      tool_count: listed.tools.length,
      tools: listed.tools.map((tool) => tool.name)
    };
  } catch (error) {
    return {
      connected: false,
      endpoint,
      tool_count: 0,
      tools: [],
      error: error?.message || String(error),
      enable_steps: [
        "Open the Figma desktop app and sign in.",
        "Open a Figma Design file.",
        "Switch to Dev Mode (Shift+D).",
        "In the MCP server section, click Enable desktop MCP server."
      ]
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2] || "status";
  const result = command === "tools" ? await listFigmaDesktopTools() : await figmaDesktopStatus();
  console.log(JSON.stringify(result, null, 2));
  if (command !== "tools" && !result.connected) process.exitCode = 1;
}
