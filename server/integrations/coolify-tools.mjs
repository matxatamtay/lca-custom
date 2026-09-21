import { z } from "zod";
import { callCoolifyMcpTool, coolifyMcpStatus, listCoolifyMcpTools } from "../coolify-mcp.mjs";

export function createCoolifyToolRegistrar(options) {
  const { reg, jsonResult, COOLIFY_BASE_URL, COOLIFY_MCP_TIMEOUT_MS, COOLIFY_ACCESS_TOKEN } = options;

  function registerCoolifyMcpTools(mcp) {
    const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true };
    const mutation = { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false };
    const bridgeOptions = {
      baseUrl: COOLIFY_BASE_URL,
      timeoutMs: COOLIFY_MCP_TIMEOUT_MS,
      accessToken: COOLIFY_ACCESS_TOKEN
    };

    reg(
      mcp,
      "coolify_status",
      {
        title: "Coolify MCP status",
        description: "Check the configured remote Coolify MCP endpoint and list its live tools without exposing the bearer token.",
        annotations: readOnly,
        inputSchema: {}
      },
      async () => jsonResult(await coolifyMcpStatus(bridgeOptions))
    );

    reg(
      mcp,
      "coolify_list_tools",
      {
        title: "List Coolify MCP tools",
        description: "List every tool and JSON schema exposed by the configured Coolify MCP server.",
        annotations: readOnly,
        inputSchema: {}
      },
      async () => {
        const result = await listCoolifyMcpTools(bridgeOptions);
        return jsonResult({ base_url: COOLIFY_BASE_URL, count: result.tools.length, tools: result.tools });
      }
    );

    reg(
      mcp,
      "coolify_call_tool",
      {
        title: "Call any Coolify MCP tool",
        description: "Forward a call to any currently exposed Coolify MCP tool. Use coolify_list_tools first to inspect the exact upstream schema.",
        annotations: mutation,
        inputSchema: {
          tool: z.string().min(1),
          arguments: z.record(z.any()).optional()
        }
      },
      async ({ tool, arguments: upstreamArguments }) => callCoolifyMcpTool(tool, upstreamArguments || {}, bridgeOptions)
    );
  }


  return registerCoolifyMcpTools;
}
