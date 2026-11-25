// Local Coding Agent — Blender MCP facade
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BLENDER_MCP_COMMIT,
  DEFAULT_BLENDER_MCP_HOST,
  DEFAULT_BLENDER_MCP_PORT,
  DEFAULT_BLENDER_MCP_SOURCE,
  callRawBlenderMcpTool,
  closeBlenderMcpClients,
  listBlenderMcpTools,
  normalizeBlenderMcpHost,
  normalizeBlenderMcpPort
} from "./blender-mcp-client.mjs";

export {
  BLENDER_MCP_COMMIT,
  DEFAULT_BLENDER_MCP_HOST,
  DEFAULT_BLENDER_MCP_PORT,
  DEFAULT_BLENDER_MCP_SOURCE,
  closeBlenderMcpClients,
  listBlenderMcpTools,
  normalizeBlenderMcpHost,
  normalizeBlenderMcpPort
};

function firstText(result) {
  return Array.isArray(result?.content)
    ? result.content.find((item) => item?.type === "text" && typeof item.text === "string")?.text || ""
    : "";
}

export function friendlyBlenderMcpError(error, host = DEFAULT_BLENDER_MCP_HOST, port = DEFAULT_BLENDER_MCP_PORT) {
  const message = String(error?.cause?.message || error?.message || error || "Unknown error");
  if (/Cannot find|ENOENT|spawn uvx|not found/i.test(message)) {
    return new Error("Blender MCP launcher is unavailable. Install uv/uvx or set BLENDER_MCP_UVX_BIN.");
  }
  if (/ECONNREFUSED|Blender.*not reachable|connection refused|Failed to connect/i.test(message)) {
    return new Error(
      `Blender MCP is installed, but Blender is not accepting commands at ${host}:${port}. ` +
      "Open Blender, enable the Blender MCP addon, then start its MCP server from View3D → Sidebar → MCP."
    );
  }
  return new Error(`Blender MCP error: ${message}`);
}

export async function callBlenderMcpTool(name, args = {}, options = {}) {
  const toolName = String(name || "").trim();
  if (!toolName) throw new Error("Blender MCP tool name is required.");
  const listed = await listBlenderMcpTools(options);
  const tool = listed.tools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    throw new Error(
      `Blender MCP does not expose tool "${toolName}". Use blender_list_tools to inspect the live schema.`
    );
  }
  try {
    const result = await callRawBlenderMcpTool(toolName, args || {}, options);
    if (result?.isError) throw new Error(firstText(result) || `Upstream tool ${toolName} failed.`);
    return result;
  } catch (error) {
    throw friendlyBlenderMcpError(
      error,
      normalizeBlenderMcpHost(options.host),
      normalizeBlenderMcpPort(options.port)
    );
  }
}

export async function blenderMcpStatus(options = {}) {
  const host = normalizeBlenderMcpHost(options.host);
  const port = normalizeBlenderMcpPort(options.port);
  const source = String(options.source ?? process.env.BLENDER_MCP_SOURCE ?? DEFAULT_BLENDER_MCP_SOURCE);
  try {
    const listed = await listBlenderMcpTools(options);
    let blenderConnected = false;
    let blender = null;
    let blenderError = null;
    if (listed.tools.some((tool) => tool.name === "ping")) {
      try {
        blender = await callRawBlenderMcpTool("ping", {}, options);
        blenderConnected = !blender?.isError;
        if (blender?.isError) blenderError = firstText(blender);
      } catch (error) {
        blenderError = friendlyBlenderMcpError(error, host, port).message;
      }
    }
    return {
      connected: true,
      blender_connected: blenderConnected,
      transport: "stdio -> loopback TCP",
      host,
      port,
      source,
      pinned_commit: BLENDER_MCP_COMMIT,
      tool_count: listed.tools.length,
      blender,
      ...(blenderError ? { blender_error: blenderError } : {})
    };
  } catch (error) {
    return {
      connected: false,
      blender_connected: false,
      transport: "stdio -> loopback TCP",
      host,
      port,
      source,
      pinned_commit: BLENDER_MCP_COMMIT,
      tool_count: 0,
      error: friendlyBlenderMcpError(error, host, port).message
    };
  }
}
