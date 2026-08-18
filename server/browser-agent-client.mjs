// Local Coding Agent — Local Browser Agent bridge
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PersistentHttpMcpClient } from "./persistent-http-mcp-client.mjs";

export const DEFAULT_BROWSER_AGENT_MCP_URL = "http://127.0.0.1:8791/mcp";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BROWSER_AGENT_ROOT = path.resolve(MODULE_DIR, "..", "local-browser-agent");

let singleton;
let managedProcess;

export function browserAgentClient(options = {}) {
  if (singleton) return singleton;
  const endpoint = String(options.endpoint || process.env.LCA_BROWSER_MCP_URL || DEFAULT_BROWSER_AGENT_MCP_URL);
  const token = String(options.authToken ?? process.env.LBA_MCP_AUTH_TOKEN ?? "");
  singleton = new PersistentHttpMcpClient({
    endpoint,
    clientName: "local-coding-agent-browser-bridge",
    timeoutMs: Number(options.timeoutMs || process.env.LCA_BROWSER_MCP_TIMEOUT_MS || 45_000),
    ...(token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {})
  });
  singleton.browserEndpoint = endpoint;
  return singleton;
}

export async function browserAgentStatus(options = {}) {
  const client = browserAgentClient(options);
  const endpoint = client.browserEndpoint;
  const healthUrl = new URL("/healthz", endpoint).toString();
  let health = await readHealth(healthUrl);
  if (!health && options.autoStart !== false) {
    await ensureLocalBrowserAgent(endpoint, options);
    health = await waitForHealth(healthUrl, 3_000);
  }
  if (!health) {
    return { ok: false, endpoint, health_url: healthUrl, error: "Local Browser Agent is not reachable." };
  }
  const listed = await client.listTools().catch(() => ({ tools: [] }));
  return {
    ok: true,
    endpoint,
    health,
    tools: (listed.tools || []).map((tool) => tool.name).filter((name) => name.startsWith("browser_"))
  };
}

export async function listBrowserAgentTools(options = {}) {
  const client = browserAgentClient(options);
  const listed = await client.listTools({ refresh: options.refresh === true });
  return (listed.tools || [])
    .filter((tool) => tool.name.startsWith("browser_"))
    .map((tool) => ({ name: tool.name, description: tool.description || "", inputSchema: tool.inputSchema || {} }));
}

export async function callBrowserAgentTool(name, args = {}, options = {}) {
  const toolName = String(name || "").trim();
  if (!/^browser_[a-z0-9_]+$/i.test(toolName)) throw new Error("Only browser_* tools can be called through workspace_ui.");
  const client = browserAgentClient(options);
  const { tool } = await client.findTool(toolName);
  if (!tool) throw new Error(`Local Browser Agent does not expose ${toolName}.`);
  return client.callTool({ name: toolName, arguments: args || {} });
}

export async function closeBrowserAgentClient() {
  const client = singleton;
  singleton = undefined;
  if (client) await client.close().catch(() => undefined);
  const child = managedProcess;
  managedProcess = undefined;
  if (child?.pid && child.exitCode === null) {
    try { child.kill("SIGTERM"); } catch {}
  }
}

async function ensureLocalBrowserAgent(endpoint, options = {}) {
  const url = new URL(endpoint);
  if (!isManagedLocalEndpoint(url)) return false;
  if (managedProcess?.exitCode === null && !managedProcess.killed) return true;
  const root = path.resolve(options.root || process.env.LCA_BROWSER_AGENT_ROOT || DEFAULT_BROWSER_AGENT_ROOT);
  const entry = path.join(root, "dist", "server", "index.mjs");
  if (!existsSync(entry)) return false;
  const port = url.port || "8791";
  try {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: { ...process.env, LBA_PORT: port },
      stdio: "ignore",
      windowsHide: true
    });
    managedProcess = child;
    child.once("exit", () => {
      if (managedProcess === child) managedProcess = undefined;
    });
    child.once("error", () => {
      if (managedProcess === child) managedProcess = undefined;
    });
    return true;
  } catch {
    managedProcess = undefined;
    return false;
  }
}

function isManagedLocalEndpoint(url) {
  return (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    && url.pathname === "/mcp"
    && (url.port || "80") === "8791";
}

async function readHealth(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(600) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await readHealth(url);
    if (health) return health;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}
