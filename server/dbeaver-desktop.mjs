// Local Coding Agent — DBeaver Desktop MCP bridge
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { pathToFileURL } from "node:url";
import {
  PersistentHttpMcpClient,
  PersistentHttpMcpClientRegistry,
  normalizeTimeout,
  persistentHttpClientKey
} from "./persistent-http-mcp-client.mjs";

export const DEFAULT_DBEAVER_DESKTOP_MCP_URL = "http://127.0.0.1:3846/mcp";
const DEFAULT_TIMEOUT_MS = 45_000;

export function normalizeDBeaverDesktopEndpoint(value = process.env.DBEAVER_DESKTOP_MCP_URL || DEFAULT_DBEAVER_DESKTOP_MCP_URL) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_DBEAVER_DESKTOP_MCP_URL).trim());
  } catch {
    throw new Error("DBEAVER_DESKTOP_MCP_URL must be a valid HTTP URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("DBEAVER_DESKTOP_MCP_URL must use http or https.");
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (!loopback && process.env.DBEAVER_DESKTOP_ALLOW_REMOTE !== "1") {
    throw new Error("DBeaver Desktop MCP must use a loopback address unless DBEAVER_DESKTOP_ALLOW_REMOTE=1.");
  }
  return url.toString();
}

const dbeaverClients = new PersistentHttpMcpClientRegistry();

export function friendlyDBeaverDesktopError(error, endpoint = normalizeDBeaverDesktopEndpoint()) {
  const message = String(error?.cause?.message || error?.message || error || "Unknown error");
  if (/ECONNREFUSED|fetch failed|Failed to open SSE stream/i.test(message)) {
    return new Error(
      `DBeaver Desktop MCP is not running at ${endpoint}. Start the patched DBeaver build and check http://127.0.0.1:3846/healthz.`
    );
  }
  if (/401|Unauthorized/i.test(message)) {
    return new Error("DBeaver Desktop MCP rejected authentication. Check DBEAVER_DESKTOP_AUTH_TOKEN and DBEAVER_MCP_AUTH_TOKEN.");
  }
  return new Error(`DBeaver Desktop MCP error: ${message}`);
}

function getDBeaverDesktopClient(options = {}) {
  const endpoint = normalizeDBeaverDesktopEndpoint(options.endpoint);
  const ms = normalizeTimeout(options.timeoutMs ?? process.env.DBEAVER_DESKTOP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const authToken = String(options.authToken ?? process.env.DBEAVER_DESKTOP_AUTH_TOKEN ?? "").trim();
  const clientName = options.clientName || "local-coding-agent-dbeaver-bridge";
  const key = `${persistentHttpClientKey({ endpoint, authToken, clientName })}|timeout=${ms}`;
  return dbeaverClients.get(key, () => new PersistentHttpMcpClient({
    endpoint,
    clientName,
    clientVersion: "1.0.0",
    timeoutMs: ms,
    ...(authToken ? { requestInit: { headers: { Authorization: `Bearer ${authToken}` } } } : {}),
    mapError: (error) => friendlyDBeaverDesktopError(error, endpoint)
  }));
}

export async function withDBeaverDesktopClient(callback, options = {}) {
  return callback(getDBeaverDesktopClient(options));
}

export async function closeDBeaverDesktopClients() {
  await dbeaverClients.closeAll();
}

export async function listDBeaverDesktopTools(options = {}) {
  return getDBeaverDesktopClient(options).listTools({ refresh: options.refresh === true });
}

export async function callDBeaverDesktopTool(name, args = {}, options = {}) {
  const toolName = String(name || "").trim();
  if (!toolName) throw new Error("DBeaver tool name is required.");
  const client = getDBeaverDesktopClient(options);
  const { listed, tool } = await client.findTool(toolName);
  if (!tool) {
    throw new Error(`DBeaver Desktop does not expose tool "${toolName}". Available: ${listed.tools.map((item) => item.name).join(", ") || "none"}`);
  }
  return client.callTool({ name: toolName, arguments: args || {} });
}

export async function callReadOnlyDBeaverDesktopTool(name, args = {}, options = {}) {
  const toolName = String(name || "").trim();
  if (!toolName) throw new Error("DBeaver tool name is required.");
  const client = getDBeaverDesktopClient(options);
  const { listed, tool } = await client.findTool(toolName);
  if (!tool) {
    throw new Error(`DBeaver Desktop does not expose tool "${toolName}". Available: ${listed.tools.map((item) => item.name).join(", ") || "none"}`);
  }
  if (tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true) {
    throw new Error(`DBeaver tool "${toolName}" is not declared read-only and cannot be called through dbeaver_call_tool.`);
  }
  return client.callTool({ name: toolName, arguments: args || {} });
}

export async function dbeaverDesktopStatus(options = {}) {
  let endpoint = String(options.endpoint || process.env.DBEAVER_DESKTOP_MCP_URL || DEFAULT_DBEAVER_DESKTOP_MCP_URL);
  try {
    endpoint = normalizeDBeaverDesktopEndpoint(endpoint);
    const listed = await listDBeaverDesktopTools({ ...options, endpoint });
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
        "Build and launch the patched DBeaver Desktop application.",
        "Confirm the embedded server is healthy at http://127.0.0.1:3846/healthz.",
        "If authentication is enabled, set matching DBEAVER_MCP_AUTH_TOKEN and DBEAVER_DESKTOP_AUTH_TOKEN values."
      ]
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2] || "status";
  const result = command === "tools" ? await listDBeaverDesktopTools() : await dbeaverDesktopStatus();
  console.log(JSON.stringify(result, null, 2));
  if (command !== "tools" && !result.connected) process.exitCode = 1;
}
