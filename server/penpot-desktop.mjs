// Local Coding Agent — Penpot MCP bridge
// SPDX-License-Identifier: AGPL-3.0-or-later

import { pathToFileURL } from "node:url";
import {
  PersistentHttpMcpClient,
  PersistentHttpMcpClientRegistry,
  normalizeTimeout,
  persistentHttpClientKey
} from "./persistent-http-mcp-client.mjs";

export const DEFAULT_PENPOT_MCP_URL = "http://127.0.0.1:9001/mcp/stream";
const DEFAULT_TIMEOUT_MS = 120_000;
const READ_ONLY_TOOLS = new Set(["high_level_overview", "penpot_api_info", "export_shape"]);
const DESTRUCTIVE_CODE_PATTERN = /(?:\.\s*(?:remove|delete|destroy|clear|detach|unlink)\s*\(|\b(?:remove|delete|destroy|clear|detach|unlink)[A-Za-z0-9_$]*\s*\()/i;

export function normalizePenpotEndpoint(value = process.env.PENPOT_MCP_URL || DEFAULT_PENPOT_MCP_URL) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_PENPOT_MCP_URL).trim());
  } catch {
    throw new Error("PENPOT_MCP_URL must be a valid HTTP URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("PENPOT_MCP_URL must use http or https.");
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (!loopback && process.env.PENPOT_MCP_ALLOW_REMOTE !== "1") {
    throw new Error("Penpot MCP must use a loopback address unless PENPOT_MCP_ALLOW_REMOTE=1.");
  }
  if (url.pathname === "/" || !url.pathname) url.pathname = "/mcp/stream";
  url.searchParams.delete("userToken");
  url.hash = "";
  return url.toString();
}

export function penpotConnectionEndpoint(endpoint, userToken) {
  const url = new URL(normalizePenpotEndpoint(endpoint));
  const token = String(userToken || "").trim();
  if (!token) throw new Error("PENPOT_USER_TOKEN is required.");
  url.searchParams.set("userToken", token);
  return url.toString();
}

export function redactPenpotSecrets(message, secrets = []) {
  let redacted = String(message || "");
  const candidates = [process.env.PENPOT_USER_TOKEN, ...secrets]
    .filter((value) => typeof value === "string" && value.length > 0);
  for (const secret of candidates) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted.replace(/([?&]userToken=)[^\s&#]+/gi, "$1[REDACTED]");
}

export function friendlyPenpotError(error, endpoint = DEFAULT_PENPOT_MCP_URL, userToken = "") {
  const message = redactPenpotSecrets(error?.cause?.message || error?.message || error || "Unknown error", [userToken]);
  if (/401|403|Unauthorized|Forbidden|authentication failed/i.test(message)) {
    return new Error("Penpot MCP rejected authentication. Create a fresh MCP user token in Penpot and update PENPOT_USER_TOKEN in .env.local.");
  }
  if (/ECONNREFUSED|fetch failed|Failed to open SSE stream|socket hang up|timed out/i.test(message)) {
    return new Error(`Penpot MCP is unavailable at ${normalizePenpotEndpoint(endpoint)}. Keep the local Penpot stack running and connect MCP from the active design file.`);
  }
  return new Error(`Penpot MCP error: ${message}`);
}

const penpotClients = new PersistentHttpMcpClientRegistry();

function getPenpotClient(options = {}) {
  if (options.client) return options.client;
  const endpoint = normalizePenpotEndpoint(options.endpoint);
  const userToken = String(options.userToken ?? process.env.PENPOT_USER_TOKEN ?? "").trim();
  const timeoutMs = normalizeTimeout(options.timeoutMs ?? process.env.PENPOT_MCP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const clientName = options.clientName || "local-coding-agent-penpot-bridge";
  const key = `${persistentHttpClientKey({ endpoint, authToken: userToken, clientName })}|timeout=${timeoutMs}`;
  return penpotClients.get(key, () => new PersistentHttpMcpClient({
    endpoint: penpotConnectionEndpoint(endpoint, userToken),
    clientName,
    clientVersion: "2.0.0",
    timeoutMs,
    mapError: (error) => friendlyPenpotError(error, endpoint, userToken)
  }));
}

export async function closePenpotClients() {
  await penpotClients.closeAll();
}

export async function listPenpotTools(options = {}) {
  return getPenpotClient(options).listTools({ refresh: options.refresh === true });
}

export function classifyPenpotTool(tool, args = {}) {
  const name = String(tool?.name || "").trim();
  if (READ_ONLY_TOOLS.has(name) || tool?.annotations?.readOnlyHint === true) return "read";
  if (name === "execute_code") {
    return DESTRUCTIVE_CODE_PATTERN.test(String(args?.code || "")) ? "destructive" : "mutation";
  }
  return tool?.annotations?.destructiveHint === true ? "destructive" : "mutation";
}

export function assertPenpotPolicy(toolName, tool, args, policy, confirmed) {
  const classification = classifyPenpotTool(tool, args);
  if (policy === "read" && classification !== "read") {
    throw new Error(`Penpot tool "${toolName}" is ${classification}; use mutate or destructive.`);
  }
  if (policy === "mutation" && classification !== "mutation") {
    throw new Error(`Penpot tool "${toolName}" is ${classification}; use the matching read or destructive action.`);
  }
  if (policy === "safe" && classification === "destructive") {
    throw new Error(`Penpot tool "${toolName}" appears destructive. Use penpot_destructive_tool only after explicit confirmation.`);
  }
  if (policy !== "destructive") return classification;
  if (classification !== "destructive") {
    throw new Error(`Penpot tool "${toolName}" is ${classification}; destructive execution is not required.`);
  }
  if (confirmed !== true) {
    throw new Error("Destructive Penpot operations require confirmed=true after explicit user confirmation.");
  }
  return classification;
}

function penpotResultError(result) {
  const text = Array.isArray(result?.content)
    ? result.content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text.trim()).find(Boolean)
    : "";
  return result?.isError === true ? text || "Penpot MCP tool call failed." : "";
}

async function callWithPolicy(name, args, policy, options = {}) {
  const toolName = String(name || "").trim();
  if (!toolName) throw new Error("Penpot MCP tool name is required.");
  const client = getPenpotClient(options);
  const listed = await client.listTools();
  const tool = listed.tools?.find((candidate) => candidate.name === toolName);
  if (!tool) {
    throw new Error(`Penpot MCP does not expose tool "${toolName}". Available: ${listed.tools?.map((candidate) => candidate.name).join(", ") || "none"}`);
  }
  assertPenpotPolicy(toolName, tool, args, policy, options.confirmed);
  const result = await client.callTool({ name: toolName, arguments: args || {} });
  const upstreamError = penpotResultError(result);
  if (upstreamError) throw friendlyPenpotError(new Error(upstreamError), options.endpoint, options.userToken);
  return result;
}

export async function callPenpotTool(name, args = {}, options = {}) {
  return callWithPolicy(name, args, "safe", options);
}

export async function callReadOnlyPenpotTool(name, args = {}, options = {}) {
  return callWithPolicy(name, args, "read", options);
}

export async function callMutatingPenpotTool(name, args = {}, options = {}) {
  return callWithPolicy(name, args, "mutation", options);
}

export async function callDestructivePenpotTool(name, args = {}, options = {}) {
  return callWithPolicy(name, args, "destructive", options);
}

function inspectionCode(source, maxDepth, maxShapes) {
  const depth = Math.max(0, Math.min(12, Number(maxDepth) || 4));
  const limit = Math.max(1, Math.min(5000, Number(maxShapes) || 500));
  return `
const state = { count: 0, truncated: false };
const asArray = (value) => {
  if (!value) return [];
  try { return Array.from(value); } catch { return []; }
};
const summarize = (shape, depth = 0) => {
  if (!shape || state.count >= ${limit}) { state.truncated = true; return null; }
  state.count += 1;
  const result = {
    id: shape.id ?? null,
    name: shape.name ?? null,
    type: shape.type ?? null,
    x: shape.x ?? null,
    y: shape.y ?? null,
    width: shape.width ?? null,
    height: shape.height ?? null,
    hidden: shape.hidden ?? false,
    blocked: shape.blocked ?? false
  };
  if (depth < ${depth}) {
    const children = asArray(shape.children).map((child) => summarize(child, depth + 1)).filter(Boolean);
    if (children.length) result.children = children;
  }
  return result;
};
const page = penpot.currentPage ?? null;
const selection = asArray(penpot.selection);
const pageShapes = asArray(page?.children ?? page?.root?.children);
const roots = ${source === "selection" ? "selection" : "pageShapes"};
return {
  page: page ? { id: page.id ?? null, name: page.name ?? null } : null,
  selection: selection.map((shape) => ({ id: shape.id ?? null, name: shape.name ?? null, type: shape.type ?? null })),
  shapes: roots.map((shape) => summarize(shape)).filter(Boolean),
  count: state.count,
  truncated: state.truncated
};`;
}

export async function inspectPenpotPage(options = {}) {
  const code = inspectionCode("page", options.maxDepth, options.maxShapes);
  return getPenpotClient(options).callTool({ name: "execute_code", arguments: { code } });
}

export async function inspectPenpotSelection(options = {}) {
  const code = inspectionCode("selection", options.maxDepth, options.maxShapes);
  return getPenpotClient(options).callTool({ name: "execute_code", arguments: { code } });
}

export async function penpotStatus(options = {}) {
  const rawEndpoint = String(options.endpoint ?? process.env.PENPOT_MCP_URL ?? DEFAULT_PENPOT_MCP_URL);
  const authConfigured = Boolean(String(options.userToken ?? process.env.PENPOT_USER_TOKEN ?? "").trim());
  let endpoint = rawEndpoint;
  try {
    endpoint = normalizePenpotEndpoint(rawEndpoint);
    const listed = await listPenpotTools({ ...options, endpoint });
    return {
      connected: true,
      transport: "streamable-http",
      endpoint,
      auth_configured: authConfigured,
      transport_secure: endpoint.startsWith("https://") || /^(?:http:\/\/)?(?:127\.0\.0\.1|localhost|\[?::1\]?)/i.test(endpoint),
      tool_count: listed.tools.length,
      tools: listed.tools.map((tool) => ({ name: tool.name, policy: classifyPenpotTool(tool) })),
      surface: "design"
    };
  } catch (error) {
    const mapped = friendlyPenpotError(error, endpoint, options.userToken);
    return {
      connected: false,
      transport: "streamable-http",
      endpoint: normalizePenpotEndpoint(endpoint),
      auth_configured: authConfigured,
      tool_count: 0,
      tools: [],
      surface: "design",
      error: mapped.message,
      enable_steps: [
        "Keep the local Penpot Docker stack running.",
        "Open the target Penpot design file and connect its MCP server.",
        "Set PENPOT_MCP_URL and PENPOT_USER_TOKEN in .env.local, then restart LCA."
      ]
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2] || "status";
  try {
    const result = command === "tools" ? await listPenpotTools() : await penpotStatus();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (command !== "tools" && !result.connected) process.exitCode = 1;
  } finally {
    await closePenpotClients();
  }
}
