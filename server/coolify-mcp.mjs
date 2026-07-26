// Local Coding Agent — Coolify remote MCP bridge
// SPDX-License-Identifier: AGPL-3.0-or-later

import { pathToFileURL } from "node:url";
import {
  PersistentHttpMcpClient,
  PersistentHttpMcpClientRegistry,
  normalizeTimeout,
  persistentHttpClientKey
} from "./persistent-http-mcp-client.mjs";

export const DEFAULT_COOLIFY_MCP_URL = "http://36.50.55.5:8000/mcp";
const DEFAULT_TIMEOUT_MS = 120_000;

export function normalizeCoolifyMcpEndpoint(value = process.env.COOLIFY_MCP_URL || DEFAULT_COOLIFY_MCP_URL) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_COOLIFY_MCP_URL).trim());
  } catch {
    throw new Error("COOLIFY_MCP_URL must be a valid HTTP URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("COOLIFY_MCP_URL must use http or https.");
  }
  if (url.pathname === "/" || !url.pathname) url.pathname = "/mcp";
  url.hash = "";
  return url.toString();
}

const coolifyClients = new PersistentHttpMcpClientRegistry();

export function friendlyCoolifyMcpError(error, endpoint = normalizeCoolifyMcpEndpoint()) {
  const message = String(error?.cause?.message || error?.message || error || "Unknown error");
  if (/401|403|Unauthorized|Forbidden|authentication failed/i.test(message)) {
    return new Error("Coolify MCP rejected authentication. Set COOLIFY_MCP_AUTH_TOKEN in .env.local using a token from Security » API Tokens.");
  }
  if (/ECONNREFUSED|fetch failed|Failed to open SSE stream|socket hang up|timed out/i.test(message)) {
    return new Error(`Coolify MCP is unavailable at ${endpoint}. Check the Coolify MCP service, reverse proxy, and firewall.`);
  }
  return new Error(`Coolify MCP error: ${message}`);
}

function getCoolifyMcpClient(options = {}) {
  const endpoint = normalizeCoolifyMcpEndpoint(options.endpoint);
  const timeoutMs = normalizeTimeout(options.timeoutMs ?? process.env.COOLIFY_MCP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const authToken = String(options.authToken ?? process.env.COOLIFY_MCP_AUTH_TOKEN ?? "").trim();
  const clientName = options.clientName || "local-coding-agent-coolify-bridge";
  const key = `${persistentHttpClientKey({ endpoint, authToken, clientName })}|timeout=${timeoutMs}`;
  return coolifyClients.get(key, () => new PersistentHttpMcpClient({
    endpoint,
    clientName,
    clientVersion: "1.0.0",
    timeoutMs,
    ...(authToken ? { requestInit: { headers: { Authorization: `Bearer ${authToken}` } } } : {}),
    mapError: (error) => friendlyCoolifyMcpError(error, endpoint)
  }));
}

export async function closeCoolifyMcpClients() {
  await coolifyClients.closeAll();
}

export async function listCoolifyMcpTools(options = {}) {
  return getCoolifyMcpClient(options).listTools({ refresh: options.refresh === true });
}

export async function callCoolifyMcpTool(name, args = {}, options = {}) {
  const toolName = String(name || "").trim();
  if (!toolName) throw new Error("Coolify MCP tool name is required.");
  const client = getCoolifyMcpClient(options);
  const { listed, tool } = await client.findTool(toolName);
  if (!tool) {
    throw new Error(`Coolify MCP does not expose tool "${toolName}". Available: ${listed.tools.map((item) => item.name).join(", ") || "none"}`);
  }
  return client.callTool({ name: toolName, arguments: args || {} });
}

export async function coolifyMcpStatus(options = {}) {
  let endpoint = String(options.endpoint || process.env.COOLIFY_MCP_URL || DEFAULT_COOLIFY_MCP_URL);
  const authConfigured = Boolean(String(options.authToken ?? process.env.COOLIFY_MCP_AUTH_TOKEN ?? "").trim());
  try {
    endpoint = normalizeCoolifyMcpEndpoint(endpoint);
    const listed = await listCoolifyMcpTools({ ...options, endpoint });
    return {
      connected: true,
      endpoint,
      auth_configured: authConfigured,
      transport_secure: endpoint.startsWith("https://"),
      tool_count: listed.tools.length,
      tools: listed.tools.map((tool) => tool.name)
    };
  } catch (error) {
    return {
      connected: false,
      endpoint,
      auth_configured: authConfigured,
      transport_secure: endpoint.startsWith("https://"),
      tool_count: 0,
      tools: [],
      error: error?.message || String(error),
      enable_steps: [
        "Set COOLIFY_MCP_URL and COOLIFY_MCP_AUTH_TOKEN in .env.local.",
        "Create the token in Coolify Security » API Tokens.",
        "Restart LCA so the server reloads the environment."
      ]
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2] || "status";
  const result = command === "tools" ? await listCoolifyMcpTools() : await coolifyMcpStatus();
  console.log(JSON.stringify(result, null, 2));
  if (command !== "tools" && !result.connected) process.exitCode = 1;
}
