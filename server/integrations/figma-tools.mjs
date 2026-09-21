import { z } from "zod";
import {
  callFigmaDesktopTool,
  figmaDesktopStatus,
  listFigmaDesktopTools,
  parseFigmaNodeReference
} from "../figma-desktop.mjs";
import {
  callFigmaRemoteTool,
  figmaRemoteStatus,
  listFigmaRemoteTools,
  resetFigmaRemoteAuthorization,
  startFigmaRemoteAuthorization
} from "../figma-remote.mjs";

export function createFigmaToolRegistrar(options) {
  const {
    reg, jsonResult, figmaRemoteBridgeOptions,
    FIGMA_DESKTOP_MCP_URL, FIGMA_DESKTOP_TIMEOUT_MS,
    FIGMA_REMOTE_ENABLED, FIGMA_REMOTE_MCP_URL, FIGMA_REMOTE_ALLOW_WRITE
  } = options;
  const FIGMA_DESKTOP_READ_ONLY_TOOLS = new Set([
    "get_code_connect_map", "get_code_connect_suggestions", "get_design_context",
    "get_figjam", "get_metadata", "get_screenshot", "get_shader_effect",
    "get_shader_fill", "get_variable_defs", "list_shader_effects", "list_shader_fills"
  ]);

  function registerFigmaDesktopTools(mcp) {
    const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };

    reg(
      mcp,
      "figma_status",
      {
        title: "Figma integration status",
        description: "Check the official Figma Remote MCP and the Figma Desktop MCP fallback, including OAuth and write readiness.",
        annotations: readOnly,
        inputSchema: {}
      },
      async () => {
        const desktop = await figmaDesktopStatus({ endpoint: FIGMA_DESKTOP_MCP_URL, timeoutMs: FIGMA_DESKTOP_TIMEOUT_MS });
        const remote = FIGMA_REMOTE_ENABLED
          ? await figmaRemoteStatus(figmaRemoteBridgeOptions())
          : {
              connected: false,
              enabled: false,
              endpoint: FIGMA_REMOTE_MCP_URL,
              authorization_required: false,
              write_enabled: FIGMA_REMOTE_ALLOW_WRITE,
              tool_count: 0,
              tools: []
            };
        const preferred = remote.connected ? "remote" : desktop.connected ? "desktop" : "none";
        const active = preferred === "remote" ? remote : desktop;
        return jsonResult({
          connected: Boolean(active.connected),
          source: preferred,
          endpoint: active.endpoint,
          tool_count: active.tool_count || 0,
          tools: active.tools || [],
          remote,
          desktop
        });
      }
    );

    reg(
      mcp,
      "figma_list_tools",
      {
        title: "List Figma Desktop tools",
        description: "List the live tools and JSON schemas exposed by the official Figma Desktop MCP server.",
        annotations: readOnly,
        inputSchema: {}
      },
      async () => {
        const result = await listFigmaDesktopTools({ endpoint: FIGMA_DESKTOP_MCP_URL, timeoutMs: FIGMA_DESKTOP_TIMEOUT_MS });
        return jsonResult({ endpoint: FIGMA_DESKTOP_MCP_URL, count: result.tools.length, tools: result.tools });
      }
    );

    reg(
      mcp,
      "figma_call_tool",
      {
        title: "Call Figma tool",
        description: "Forward a call to Figma Remote MCP or the Desktop fallback. Remote write tools require FIGMA_REMOTE_ALLOW_WRITE=1.",
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
        inputSchema: {
          tool: z.string().min(1).describe("Exact upstream Figma MCP tool name."),
          source: z.enum(["auto", "remote", "desktop"]).optional().describe("Upstream source. Auto prefers Remote when enabled and the tool exists."),
          arguments: z.record(z.any()).optional().describe("Arguments matching the upstream tool JSON schema.")
        }
      },
      async ({ tool, source = "auto", arguments: args = {} }) => callConfiguredFigmaTool(tool, args, source)
    );

    reg(
      mcp,
      "figma_remote_status",
      {
        title: "Figma Remote status",
        description: "Check hosted Figma MCP connectivity, OAuth readiness, available tools, and whether write calls are enabled.",
        annotations: readOnly,
        inputSchema: {}
      },
      async () => jsonResult(
        FIGMA_REMOTE_ENABLED
          ? await figmaRemoteStatus(figmaRemoteBridgeOptions())
          : {
              connected: false,
              enabled: false,
              endpoint: FIGMA_REMOTE_MCP_URL,
              write_enabled: FIGMA_REMOTE_ALLOW_WRITE,
              error: "Set FIGMA_REMOTE_ENABLED=1 and restart LCA."
            }
      )
    );

    reg(
      mcp,
      "figma_remote_auth_start",
      {
        title: "Start Figma OAuth",
        description: "Start the official Figma Remote MCP OAuth PKCE flow and return the authorization URL. Open that URL in a browser.",
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
        inputSchema: {}
      },
      async () => {
        if (!FIGMA_REMOTE_ENABLED) throw new Error("Set FIGMA_REMOTE_ENABLED=1 and restart LCA first.");
        return jsonResult(await startFigmaRemoteAuthorization(figmaRemoteBridgeOptions()));
      }
    );

    reg(
      mcp,
      "figma_remote_auth_reset",
      {
        title: "Reset Figma OAuth",
        description: "Delete LCA's locally stored Figma OAuth client registration and tokens, then require a fresh authorization.",
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
        inputSchema: {}
      },
      async () => {
        if (!FIGMA_REMOTE_ENABLED) throw new Error("Figma Remote MCP is not enabled.");
        return jsonResult(await resetFigmaRemoteAuthorization(figmaRemoteBridgeOptions()));
      }
    );

    reg(
      mcp,
      "figma_remote_list_tools",
      {
        title: "List Figma Remote tools",
        description: "List live hosted Figma MCP tools, schemas, and annotations after OAuth authentication.",
        annotations: readOnly,
        inputSchema: { refresh: z.boolean().optional() }
      },
      async ({ refresh = false }) => {
        if (!FIGMA_REMOTE_ENABLED) throw new Error("Set FIGMA_REMOTE_ENABLED=1 and restart LCA first.");
        const result = await listFigmaRemoteTools({ ...figmaRemoteBridgeOptions(), refresh });
        return jsonResult({ endpoint: FIGMA_REMOTE_MCP_URL, count: result.tools.length, tools: result.tools });
      }
    );

    reg(
      mcp,
      "figma_remote_call_tool",
      {
        title: "Call Figma Remote tool",
        description: "Call any live hosted Figma MCP tool. Unknown or write-capable tools are blocked unless FIGMA_REMOTE_ALLOW_WRITE=1.",
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
        inputSchema: {
          tool: z.string().min(1),
          arguments: z.record(z.any()).optional()
        }
      },
      async ({ tool, arguments: args = {} }) => {
        if (!FIGMA_REMOTE_ENABLED) throw new Error("Set FIGMA_REMOTE_ENABLED=1 and restart LCA first.");
        return callFigmaRemoteTool(tool, args, figmaRemoteBridgeOptions());
      }
    );

    registerFigmaReadWrapper(mcp, "figma_get_design_context", "get_design_context", "Get implementation-oriented design context for a Figma URL, node ID, or the current desktop selection.");
    registerFigmaReadWrapper(mcp, "figma_get_screenshot", "get_screenshot", "Get a screenshot of a Figma URL, node ID, or the current desktop selection.");
    registerFigmaReadWrapper(mcp, "figma_get_metadata", "get_metadata", "Get sparse layer metadata for a Figma URL, node ID, page, or current selection.");
    registerFigmaReadWrapper(mcp, "figma_get_variable_defs", "get_variable_defs", "Get variables and styles used by a Figma URL, node ID, or current selection.");
    registerFigmaReadWrapper(mcp, "figma_get_code_connect_map", "get_code_connect_map", "Get Code Connect mappings for a Figma URL, node ID, or current selection.");
    registerFigmaReadWrapper(mcp, "figma_get_figjam", "get_figjam", "Get XML context for a FigJam URL, node ID, or current selection.");
  }

  async function callConfiguredFigmaTool(tool, args, source = "auto") {
    if (source === "remote") {
      if (!FIGMA_REMOTE_ENABLED) throw new Error("Set FIGMA_REMOTE_ENABLED=1 and restart LCA first.");
      return callFigmaRemoteTool(tool, args, figmaRemoteBridgeOptions());
    }
    if (source === "desktop") {
      return callFigmaDesktopTool(tool, args, { endpoint: FIGMA_DESKTOP_MCP_URL, timeoutMs: FIGMA_DESKTOP_TIMEOUT_MS });
    }
    if (FIGMA_REMOTE_ENABLED) {
      try {
        const listed = await listFigmaRemoteTools(figmaRemoteBridgeOptions());
        if (listed.tools?.some((candidate) => candidate.name === tool)) {
          return callFigmaRemoteTool(tool, args, figmaRemoteBridgeOptions());
        }
      } catch (error) {
        if (!FIGMA_DESKTOP_READ_ONLY_TOOLS.has(tool)) throw error;
      }
    }
    return callFigmaDesktopTool(tool, args, { endpoint: FIGMA_DESKTOP_MCP_URL, timeoutMs: FIGMA_DESKTOP_TIMEOUT_MS });
  }

  async function callConfiguredFigmaReadTool(upstreamName, input, source) {
    if (source === "remote") {
      return callConfiguredFigmaTool(upstreamName, buildFigmaRemoteArguments(input), "remote");
    }
    if (source === "desktop") {
      return callConfiguredFigmaTool(upstreamName, buildFigmaDesktopArguments(input), "desktop");
    }
    if (FIGMA_REMOTE_ENABLED && input?.url) {
      try {
        return await callConfiguredFigmaTool(upstreamName, buildFigmaRemoteArguments(input), "remote");
      } catch {
        // URL-based remote reads gracefully fall back to the current desktop bridge.
      }
    }
    return callConfiguredFigmaTool(upstreamName, buildFigmaDesktopArguments(input), "desktop");
  }

  function registerFigmaReadWrapper(mcp, lcaName, upstreamName, description) {
    reg(
      mcp,
      lcaName,
      {
        title: upstreamName.replaceAll("_", " "),
        description,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
        inputSchema: {
          url: z.string().url().optional().describe("Optional Figma node/frame URL. The node-id is extracted automatically."),
          node_id: z.string().optional().describe("Optional node ID such as 123:456 or 123-456. Omit to use the current Figma desktop selection."),
          client_languages: z.array(z.string()).optional().describe("Languages used by the target codebase, forwarded as clientLanguages."),
          client_frameworks: z.array(z.string()).optional().describe("Frameworks or Code Connect labels, forwarded as clientFrameworks."),
          force_code: z.boolean().optional().describe("Forwarded as forceCode when supported by the upstream tool."),
          enable_base64_response: z.boolean().optional().describe("Forwarded as enableBase64Response when supported, mainly for screenshots."),
          source: z.enum(["auto", "remote", "desktop"]).optional().describe("Auto prefers Remote for URL-based reads and falls back to Desktop."),
          arguments: z.record(z.any()).optional().describe("Additional or overriding upstream arguments for forward compatibility.")
        }
      },
      async (input) => callConfiguredFigmaReadTool(upstreamName, input, input?.source || "auto")
    );
  }

  function buildFigmaDesktopArguments({
    url,
    node_id,
    client_languages,
    client_frameworks,
    force_code,
    enable_base64_response,
    arguments: extra = {}
  } = {}) {
    const args = { ...(extra || {}) };
    const reference = parseFigmaNodeReference(url || node_id || "");
    if (reference.nodeId && args.nodeId === undefined) args.nodeId = reference.nodeId;
    if (client_languages?.length && args.clientLanguages === undefined) args.clientLanguages = client_languages;
    if (client_frameworks?.length && args.clientFrameworks === undefined) args.clientFrameworks = client_frameworks;
    if (force_code !== undefined && args.forceCode === undefined) args.forceCode = force_code;
    if (enable_base64_response !== undefined && args.enableBase64Response === undefined) args.enableBase64Response = enable_base64_response;
    return args;
  }

  function buildFigmaRemoteArguments(input = {}) {
    const args = buildFigmaDesktopArguments(input);
    const reference = parseFigmaNodeReference(input.url || input.node_id || "");
    if (reference.fileKey && args.fileKey === undefined) args.fileKey = reference.fileKey;
    return args;
  }


  return registerFigmaDesktopTools;
}
