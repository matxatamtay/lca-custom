// Local Coding Agent — Bruno Desktop MCP bridge
// SPDX-License-Identifier: AGPL-3.0-or-later

import { pathToFileURL } from "node:url";
import {
  PersistentHttpMcpClient,
  PersistentHttpMcpClientRegistry,
  normalizeTimeout,
  persistentHttpClientKey
} from "./persistent-http-mcp-client.mjs";

export const DEFAULT_BRUNO_DESKTOP_MCP_URL = "http://127.0.0.1:3847/mcp";
const DEFAULT_TIMEOUT_MS = 120_000;

export function normalizeBrunoDesktopEndpoint(value = process.env.BRUNO_DESKTOP_MCP_URL || DEFAULT_BRUNO_DESKTOP_MCP_URL) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_BRUNO_DESKTOP_MCP_URL).trim());
  } catch {
    throw new Error("BRUNO_DESKTOP_MCP_URL must be a valid HTTP URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("BRUNO_DESKTOP_MCP_URL must use http or https.");
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (!loopback && process.env.BRUNO_DESKTOP_ALLOW_REMOTE !== "1") {
    throw new Error("Bruno Desktop MCP must use a loopback address unless BRUNO_DESKTOP_ALLOW_REMOTE=1.");
  }
  if (url.pathname === "/" || !url.pathname) url.pathname = "/mcp";
  return url.toString();
}

const brunoClients = new PersistentHttpMcpClientRegistry();

export function friendlyBrunoDesktopError(error, endpoint = normalizeBrunoDesktopEndpoint()) {
  const message = String(error?.cause?.message || error?.message || error || "Unknown error");
  if (/ECONNREFUSED|fetch failed|Failed to open SSE stream|socket hang up/i.test(message)) {
    return new Error(
      `Bruno Desktop MCP is not running at ${endpoint}. Open Bruno, enable MCP in Preferences, and confirm http://127.0.0.1:3847/healthz is healthy.`
    );
  }
  if (/401|Unauthorized|authentication failed/i.test(message)) {
    return new Error("Bruno Desktop MCP rejected authentication. Rotate or copy the token in Bruno Preferences and update BRUNO_DESKTOP_AUTH_TOKEN.");
  }
  return new Error(`Bruno Desktop MCP error: ${message}`);
}

function getBrunoDesktopClient(options = {}) {
  const endpoint = normalizeBrunoDesktopEndpoint(options.endpoint);
  const ms = normalizeTimeout(options.timeoutMs ?? process.env.BRUNO_DESKTOP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const authToken = String(options.authToken ?? process.env.BRUNO_DESKTOP_AUTH_TOKEN ?? "").trim();
  const clientName = options.clientName || "local-coding-agent-bruno-bridge";
  const key = `${persistentHttpClientKey({ endpoint, authToken, clientName })}|timeout=${ms}`;
  return brunoClients.get(key, () => new PersistentHttpMcpClient({
    endpoint,
    clientName,
    clientVersion: "2.0.0",
    timeoutMs: ms,
    ...(authToken ? { requestInit: { headers: { Authorization: `Bearer ${authToken}` } } } : {}),
    mapError: (error) => friendlyBrunoDesktopError(error, endpoint)
  }));
}

export async function withBrunoDesktopClient(callback, options = {}) {
  return callback(getBrunoDesktopClient(options));
}

export async function closeBrunoDesktopClients() {
  await brunoClients.closeAll();
}

export async function listBrunoDesktopTools(options = {}) {
  return getBrunoDesktopClient(options).listTools({ refresh: options.refresh === true });
}

export async function callBrunoDesktopTool(name, args = {}, options = {}) {
  const toolName = String(name || "").trim();
  if (!toolName) throw new Error("Bruno tool name is required.");
  const client = getBrunoDesktopClient(options);
  const { listed, tool } = await client.findTool(toolName);
  if (!tool) {
    throw new Error(`Bruno Desktop does not expose tool "${toolName}". Available: ${listed.tools.map((item) => item.name).join(", ") || "none"}`);
  }
  return client.callTool({ name: toolName, arguments: args || {} });
}

export async function brunoDesktopStatus(options = {}) {
  let endpoint = String(options.endpoint || process.env.BRUNO_DESKTOP_MCP_URL || DEFAULT_BRUNO_DESKTOP_MCP_URL);
  try {
    endpoint = normalizeBrunoDesktopEndpoint(endpoint);
    const listed = await listBrunoDesktopTools({ ...options, endpoint });
    return {
      connected: true,
      endpoint,
      tool_count: listed.tools.length,
      tools: listed.tools.map((tool) => tool.name),
      surface: "collections"
    };
  } catch (error) {
    return {
      connected: false,
      endpoint,
      tool_count: 0,
      tools: [],
      surface: "collections",
      error: error?.message || String(error),
      enable_steps: [
        "Open Bruno Desktop.",
        "Enable Bruno MCP in Preferences.",
        "Copy or rotate the local token and set BRUNO_DESKTOP_AUTH_TOKEN for Local Coding Agent."
      ]
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2] || "status";
  const result = command === "tools" ? await listBrunoDesktopTools() : await brunoDesktopStatus();
  console.log(JSON.stringify(result, null, 2));
  if (command !== "tools" && !result.connected) process.exitCode = 1;
}
