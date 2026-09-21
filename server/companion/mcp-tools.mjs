import { z } from "zod";

export function createCompanionMcp(options) {
  const {
    COMPANION_QUICK_ACTIONS, COMPANION_WIDGET_RESOURCE, COMPANION_WIDGET_URI,
    DBEAVER_SQL_ARTIFACT_LEGACY_URI, DBEAVER_SQL_ARTIFACT_RESOURCE, DBEAVER_SQL_ARTIFACT_URI,
    PRIMARY_ROOT, ROOTS, WORKFLOW_COMMANDS, composeLcaPrompt, reg, resolvePath, slashCommandData,
    structuredJsonResult, workspaceSearchData
  } = options;

  function widgetResourcePayload(uri, resource, description) {
    return {
      contents: [
        {
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: resource.text,
          _meta: {
            ui: {
              prefersBorder: true,
              csp: { connectDomains: [], resourceDomains: [] }
            },
            "openai/widgetDescription": description,
            "openai/widgetPrefersBorder": true,
            "openai/widgetCSP": { connect_domains: [], resource_domains: [] }
          }
        }
      ]
    };
  }

  function registerCompanionAppResources(mcp) {
    const companionDescription = "Compact LCA input composer for PiP: one low-height prompt box with @ context, / workflow autocomplete, Enter-to-send, and token highlights.";
    const sqlArtifactDescription = "Interactive SQL artifact for DBeaver with Open, native-confirmed Run, Explain, and Save Snippet actions.";
    mcp.registerResource(
      "lca-companion-widget",
      COMPANION_WIDGET_URI,
      {},
      async () => widgetResourcePayload(COMPANION_WIDGET_URI, COMPANION_WIDGET_RESOURCE, companionDescription)
    );
    mcp.registerResource(
      "dbeaver-sql-artifact-widget",
      DBEAVER_SQL_ARTIFACT_URI,
      {},
      async () => widgetResourcePayload(DBEAVER_SQL_ARTIFACT_URI, DBEAVER_SQL_ARTIFACT_RESOURCE, sqlArtifactDescription)
    );
    mcp.registerResource(
      "dbeaver-sql-artifact-widget-legacy",
      DBEAVER_SQL_ARTIFACT_LEGACY_URI,
      {},
      async () => widgetResourcePayload(DBEAVER_SQL_ARTIFACT_LEGACY_URI, DBEAVER_SQL_ARTIFACT_RESOURCE, sqlArtifactDescription)
    );
  }

  function registerCompanionTools(mcp) {
    reg(
      mcp,
      "workspace_search",
      {
        title: "Workspace @ search",
        description: "Autocomplete backend for @ file/folder/symbol/skill search in a ChatGPT companion UI. Use this when the user mentions @... or wants to pick workspace context without copying paths.",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
        inputSchema: {
          query: z.string().optional().describe("Search text, usually what the user typed after @. @/ or empty returns top-level context."),
          path: z.string().optional().describe("Specific project root or subdirectory to search. Omit to search every configured project root."),
          include: z.array(z.enum(["file", "folder", "symbol", "skill"])).optional().describe("Context kinds to include."),
          limit: z.number().int().min(1).max(100).optional()
        }
      },
      async ({ query = "", path: rel, include, limit = 30 }) => {
        const rootDirs = rel ? [resolvePath(rel)] : ROOTS;
        const result = await workspaceSearchData(rootDirs, query, { include, limit });
        return structuredJsonResult(result);
      }
    );

    reg(
      mcp,
      "slash_commands",
      {
        title: "Slash commands",
        description: "Autocomplete backend for / workflow commands, mode tags, and skill shortcuts. Use this for /plan, /debug, /review, /skill:<name>, etc.",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
        inputSchema: {
          query: z.string().optional().describe("Search text, usually what the user typed after /."),
          include: z.array(z.enum(["workflow", "mode", "skill"])).optional(),
          limit: z.number().int().min(1).max(100).optional()
        }
      },
      async ({ query = "", include, limit = 30 }) => {
        const result = await slashCommandData(query, { include, limit });
        return structuredJsonResult(result);
      }
    );

    reg(
      mcp,
      "compose_prompt",
      {
        title: "Compose LCA prompt",
        description: "Parse sidebar-style input containing @ context and / workflow commands, resolve selected paths, and return a ready-to-send prompt for ChatGPT.",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
        inputSchema: {
          input: z.string().min(1).describe("User task text, may include @mentions and /commands."),
          path: z.string().optional().describe("Specific project root or subdirectory to resolve @mentions against. Omit to use every configured project root."),
          mode: z.enum(WORKFLOW_COMMANDS.map((c) => c.name)).optional().describe("Workflow/mode override."),
          selected_context: z.array(z.string().min(1)).optional().describe("Already-selected file/folder paths from the UI."),
          include_context_pack: z.boolean().optional().describe("Ask ChatGPT to call workspace_snapshot/context tools first.")
        }
      },
      async ({ input, path: rel, mode, selected_context = [], include_context_pack = true }) => {
        const rootDirs = rel ? [resolvePath(rel)] : ROOTS;
        const result = await composeLcaPrompt(input, rootDirs, { mode, selectedContext: selected_context, includeContextPack: include_context_pack });
        return structuredJsonResult(result);
      }
    );

    registerLcaInputTool(mcp, "lca_input", "LCA input", "Render the LCA Apps SDK input widget inside ChatGPT. The widget lets the user request PiP so the composer can stay visible while the conversation continues.");
  }

  function registerLcaInputTool(mcp, name, title, description) {
    reg(
      mcp,
      name,
      {
        title,
        description,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
        inputSchema: {
          initial_input: z.string().optional().describe("Optional text to prefill in the companion composer.")
        },
        _meta: {
          ui: { resourceUri: COMPANION_WIDGET_URI, visibility: ["model", "app"] },
          "openai/outputTemplate": COMPANION_WIDGET_URI,
          "openai/widgetAccessible": true,
          "openai/toolInvocation/invoking": "Opening LCA input…",
          "openai/toolInvocation/invoked": "LCA input ready."
        }
      },
      async ({ initial_input = "" }) => {
        const payload = {
          initial_input,
          workspace: PRIMARY_ROOT,
          projects: ROOTS,
          shortcuts: WORKFLOW_COMMANDS
            .filter(({ name }) => COMPANION_QUICK_ACTIONS.has(name))
            .map(({ command, label, description, type, name }) => ({ command, label, description, type, name }))
        };
        return {
          structuredContent: payload,
          content: [{ type: "text", text: "LCA input is ready. Request PiP to keep it visible when supported, use @ for context, / for workflows or skills, or the Plan quick action." }]
        };
      }
    );
  }


  return { registerCompanionAppResources, registerCompanionTools, registerLcaInputTool };
}
