import { z } from "zod";
import { blenderMcpStatus, callBlenderMcpTool, listBlenderMcpTools } from "../blender-mcp.mjs";

export function createBlenderToolRegistrar(options) {
  const {
    reg, jsonResult, BLENDER_MCP_HOST, BLENDER_MCP_PORT,
    BLENDER_MCP_TIMEOUT_MS, BLENDER_MCP_SOURCE, BLENDER_MCP_UVX_BIN
  } = options;

  function registerBlenderMcpTools(mcp) {
    const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };
    const mutation = { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false };
    const bridgeOptions = {
      host: BLENDER_MCP_HOST,
      port: BLENDER_MCP_PORT,
      timeoutMs: BLENDER_MCP_TIMEOUT_MS,
      source: BLENDER_MCP_SOURCE,
      command: BLENDER_MCP_UVX_BIN
    };

    reg(
      mcp,
      "blender_status",
      {
        title: "Blender MCP status",
        description: "Check the pinned Blender MCP stdio server, Blender addon socket, and upstream tool count.",
        annotations: readOnly,
        inputSchema: {}
      },
      async () => jsonResult(await blenderMcpStatus(bridgeOptions))
    );

    reg(
      mcp,
      "blender_list_tools",
      {
        title: "List Blender MCP tools",
        description: "List every typed Blender MCP tool and its JSON schema.",
        annotations: readOnly,
        inputSchema: {}
      },
      async () => {
        const result = await listBlenderMcpTools(bridgeOptions);
        return jsonResult({ count: result.tools.length, tools: result.tools });
      }
    );

    reg(
      mcp,
      "blender_call_tool",
      {
        title: "Call any Blender MCP tool",
        description: "Forward a call to any live Blender MCP tool. Use blender_list_tools first when the exact schema is unknown.",
        annotations: mutation,
        inputSchema: { tool: z.string().min(1), arguments: z.record(z.any()).optional() }
      },
      async ({ tool, arguments: upstreamArguments }) =>
        callBlenderMcpTool(tool, upstreamArguments || {}, bridgeOptions)
    );
  }

  return registerBlenderMcpTools;
}
