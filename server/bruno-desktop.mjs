// Local Coding Agent — Bruno Desktop MCP bridge
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pathToFileURL } from "node:url";

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

function timeoutMs(value) {
  const parsed = Number(value ?? process.env.BRUNO_DESKTOP_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(300_000, Math.max(1_000, Math.trunc(parsed)));
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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

export async function withBrunoDesktopClient(callback, options = {}) {
  const endpoint = normalizeBrunoDesktopEndpoint(options.endpoint);
  const ms = timeoutMs(options.timeoutMs);
  const authToken = String(options.authToken ?? process.env.BRUNO_DESKTOP_AUTH_TOKEN ?? "").trim();
  const client = new Client({ name: options.clientName || "local-coding-agent-bruno-bridge", version: "2.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : undefined
  });
  try {
    await withTimeout(client.connect(transport), ms, "Connecting to Bruno Desktop MCP");
    return await withTimeout(Promise.resolve(callback(client)), ms, "Bruno Desktop MCP request");
  } catch (error) {
    throw friendlyBrunoDesktopError(error, endpoint);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function listBrunoDesktopTools(options = {}) {
  return withBrunoDesktopClient((client) => client.listTools(), options);
}

export async function callBrunoDesktopTool(name, args = {}, options = {}) {
  const toolName = String(name || "").trim();
  if (!toolName) throw new Error("Bruno tool name is required.");
  return withBrunoDesktopClient(async (client) => {
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new Error(`Bruno Desktop does not expose tool "${toolName}". Available: ${listed.tools.map((item) => item.name).join(", ") || "none"}`);
    }
    return client.callTool({ name: toolName, arguments: args || {} });
  }, options);
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
