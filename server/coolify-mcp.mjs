// Local Coding Agent — Coolify MCP facade
// SPDX-License-Identifier: AGPL-3.0-or-later

import { pathToFileURL } from "node:url";
import {
  COOLIFY_MCP_PACKAGE,
  COOLIFY_MCP_VERSION,
  DEFAULT_COOLIFY_BASE_URL,
  callRawCoolifyMcpTool,
  closeCoolifyMcpClients,
  listCoolifyMcpTools,
  normalizeCoolifyBaseUrl,
  resolveCoolifyMcpEntry
} from "./coolify-mcp-client.mjs";
import {
  assertCoolifyPolicy,
  classifyCoolifyTool,
  coolifyToolResultError,
  redactKnownSecrets
} from "./coolify-mcp-policy.mjs";

export {
  COOLIFY_MCP_PACKAGE,
  COOLIFY_MCP_VERSION,
  DEFAULT_COOLIFY_BASE_URL,
  classifyCoolifyTool,
  closeCoolifyMcpClients,
  listCoolifyMcpTools,
  normalizeCoolifyBaseUrl,
  resolveCoolifyMcpEntry
};

export function friendlyCoolifyMcpError(
  error,
  baseUrl = process.env.COOLIFY_BASE_URL || "",
  accessToken = ""
) {
  const message = redactKnownSecrets(
    error?.cause?.message || error?.message || error || "Unknown error",
    [accessToken]
  );

  if (/401|403|Unauthorized|Forbidden|authentication failed/i.test(message)) {
    return new Error("Coolify rejected authentication. Set COOLIFY_ACCESS_TOKEN in .env.local using a Coolify API token with the required team role/scopes.");
  }
  if (/Cannot find package|ERR_MODULE_NOT_FOUND|ENOENT/i.test(message)) {
    return new Error(`Coolify MCP ${COOLIFY_MCP_VERSION} is not installed. Run npm install in the LCA server directory.`);
  }
  if (/ECONNREFUSED|fetch failed|socket hang up|timed out|Request timed out/i.test(message)) {
    const target = baseUrl ? ` at ${baseUrl}` : "";
    return new Error(`Coolify is unavailable${target}. Check the instance URL, reverse proxy, firewall, and API availability.`);
  }
  return new Error(`Coolify MCP error: ${message}`);
}

async function callWithPolicy(name, args, policy, options = {}) {
  const toolName = String(name || "").trim();
  if (!toolName) throw new Error("Coolify MCP tool name is required.");

  const listed = await listCoolifyMcpTools(options);
  const tool = listed.tools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    const available = listed.tools.map((candidate) => candidate.name).join(", ") || "none";
    throw new Error(`Coolify MCP does not expose tool "${toolName}". Available: ${available}`);
  }

  assertCoolifyPolicy(toolName, tool, args, policy, options.confirmed);

  let result;
  try {
    result = await callRawCoolifyMcpTool(toolName, args || {}, options);
  } catch (error) {
    throw friendlyCoolifyMcpError(error, options.baseUrl, options.accessToken);
  }

  const upstreamError = coolifyToolResultError(result);
  if (upstreamError) {
    throw friendlyCoolifyMcpError(new Error(upstreamError), options.baseUrl, options.accessToken);
  }
  return result;
}

// Compatibility path: permits reads and ordinary mutations, but blocks destructive actions.
export async function callCoolifyMcpTool(name, args = {}, options = {}) {
  return callWithPolicy(name, args, "safe", options);
}

export async function callReadOnlyCoolifyMcpTool(name, args = {}, options = {}) {
  return callWithPolicy(name, args, "read", options);
}

export async function callMutatingCoolifyMcpTool(name, args = {}, options = {}) {
  return callWithPolicy(name, args, "mutation", options);
}

export async function callDestructiveCoolifyMcpTool(name, args = {}, options = {}) {
  return callWithPolicy(name, args, "destructive", options);
}

function versionFromResult(result) {
  const text = Array.isArray(result?.content)
    ? result.content.find((item) => item?.type === "text" && typeof item.text === "string")?.text?.trim()
    : undefined;
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.version === "string" ? parsed.version : text;
  } catch {
    return text;
  }
}

export async function coolifyMcpStatus(options = {}) {
  const rawBaseUrl = String(options.baseUrl ?? process.env.COOLIFY_BASE_URL ?? "").trim();
  const authConfigured = Boolean(String(options.accessToken ?? process.env.COOLIFY_ACCESS_TOKEN ?? "").trim());
  let baseUrl = rawBaseUrl;

  try {
    baseUrl = normalizeCoolifyBaseUrl(rawBaseUrl);
    const listed = await listCoolifyMcpTools({ ...options, baseUrl });
    const versionResult = await callReadOnlyCoolifyMcpTool("get_version", {}, { ...options, baseUrl });

    return {
      connected: true,
      transport: "stdio",
      package: `${COOLIFY_MCP_PACKAGE}@${COOLIFY_MCP_VERSION}`,
      base_url: baseUrl,
      auth_configured: authConfigured,
      transport_secure: baseUrl.startsWith("https://"),
      api_version: versionFromResult(versionResult),
      tool_count: listed.tools.length,
      tools: listed.tools.map((tool) => ({
        name: tool.name,
        policy: classifyCoolifyTool(tool)
      }))
    };
  } catch (error) {
    const mapped = friendlyCoolifyMcpError(error, baseUrl, options.accessToken);
    return {
      connected: false,
      transport: "stdio",
      package: `${COOLIFY_MCP_PACKAGE}@${COOLIFY_MCP_VERSION}`,
      base_url: baseUrl,
      auth_configured: authConfigured,
      transport_secure: baseUrl.startsWith("https://"),
      tool_count: 0,
      tools: [],
      error: mapped.message,
      enable_steps: [
        "Set COOLIFY_BASE_URL and COOLIFY_ACCESS_TOKEN in .env.local.",
        "Create the token in Coolify Settings → API with the minimum required role/scopes.",
        "Restart LCA so the server reloads the environment."
      ]
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2] || "status";
  try {
    const result = command === "tools" ? await listCoolifyMcpTools() : await coolifyMcpStatus();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (command !== "tools" && !result.connected) process.exitCode = 1;
  } finally {
    await closeCoolifyMcpClients();
  }
}
