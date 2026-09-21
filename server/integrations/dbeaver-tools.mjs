import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  callDBeaverDesktopTool, callReadOnlyDBeaverDesktopTool,
  dbeaverDesktopStatus, listDBeaverDesktopTools
} from "../dbeaver-desktop.mjs";

export function createDBeaverToolRegistrar(options) {
  const {
    reg, jsonResult, DBEAVER_DESKTOP_MCP_URL, DBEAVER_DESKTOP_TIMEOUT_MS,
    DBEAVER_DESKTOP_AUTH_TOKEN, DBEAVER_RUN_INTENT_TTL_MS, DBEAVER_SQL_ARTIFACT_URI
  } = options;
  const dbeaverRunIntents = new Map();

  function dbeaverToolPayload(result) {
    if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
    const text = result?.content?.find?.((item) => item?.type === "text")?.text;
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function pruneDBeaverRunIntents(now = Date.now()) {
    for (const [token, intent] of dbeaverRunIntents) {
      if (!intent || intent.expiresAtMs <= now || intent.status === "consumed") dbeaverRunIntents.delete(token);
    }
  }

  function createDBeaverRunIntent(payload, args) {
    pruneDBeaverRunIntents();
    const token = randomUUID();
    const expiresAtMs = Date.now() + DBEAVER_RUN_INTENT_TTL_MS;
    const sql = String(payload?.sql || args?.sql || "");
    const connection = payload?.connection && typeof payload.connection === "object" ? payload.connection : {};
    const intent = {
      token,
      editorId: String(payload?.editor_id || args?.editor_id || ""),
      proposalId: String(payload?.proposal_id || ""),
      connectionId: String(connection.id || args?.connection || ""),
      project: String(connection.project || args?.project || ""),
      sql,
      sqlSha256: createHash("sha256").update(sql).digest("hex"),
      expiresAtMs,
      status: "ready",
      approvalId: ""
    };
    dbeaverRunIntents.set(token, intent);
    return intent;
  }

  function requireDBeaverRunIntent(token, editorId = "") {
    pruneDBeaverRunIntents();
    const intent = dbeaverRunIntents.get(String(token || ""));
    if (!intent) {
      throw new Error("SQL execution must start from the SQL Artifact Run button. Create a proposal with dbeaver_propose_sql, then stop and wait for the user to click Run.");
    }
    if (editorId && intent.editorId && String(editorId) !== intent.editorId) {
      throw new Error("The SQL Artifact Run capability is bound to a different DBeaver editor. Create a fresh proposal for this editor.");
    }
    return intent;
  }

  function registerDBeaverDesktopTools(mcp) {
    const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };
    const bridgeOptions = {
      endpoint: DBEAVER_DESKTOP_MCP_URL,
      timeoutMs: DBEAVER_DESKTOP_TIMEOUT_MS,
      authToken: DBEAVER_DESKTOP_AUTH_TOKEN
    };
    const uiMutation = { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false };
    const execution = { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false };
    const forward = (name, title, description, annotations, inputSchema, meta) => reg(
      mcp,
      name,
      { title, description, annotations, inputSchema, ...(meta ? { _meta: meta } : {}) },
      async (args) => callDBeaverDesktopTool(name, args, bridgeOptions)
    );

    reg(
      mcp,
      "dbeaver_status",
      {
        title: "DBeaver Desktop status",
        description: "Check whether the patched DBeaver Desktop MCP server is running and list its live tools.",
        annotations: readOnly,
        inputSchema: {}
      },
      async () => jsonResult(await dbeaverDesktopStatus(bridgeOptions))
    );

    reg(
      mcp,
      "dbeaver_list_tools",
      {
        title: "List DBeaver Desktop tools",
        description: "List the tools and JSON schemas exposed by the patched DBeaver Desktop MCP server.",
        annotations: readOnly,
        inputSchema: {}
      },
      async () => {
        const result = await listDBeaverDesktopTools(bridgeOptions);
        return jsonResult({ endpoint: DBEAVER_DESKTOP_MCP_URL, count: result.tools.length, tools: result.tools });
      }
    );

    reg(
      mcp,
      "dbeaver_call_tool",
      {
        title: "Call a read-only DBeaver tool",
        description: "Call any upstream DBeaver Desktop tool that declares readOnlyHint=true. Use dbeaver_list_tools to inspect names and schemas. Write-capable tools are rejected.",
        annotations: readOnly,
        inputSchema: {
          tool: z.string().min(1).describe("Exact upstream DBeaver tool name."),
          arguments: z.record(z.any()).optional().describe("Arguments matching the upstream tool JSON schema.")
        }
      },
      async ({ tool, arguments: upstreamArguments }) => callReadOnlyDBeaverDesktopTool(tool, upstreamArguments || {}, bridgeOptions)
    );

    reg(
      mcp,
      "dbeaver_list_connections",
      {
        title: "List DBeaver connections",
        description: "List live DBeaver connection IDs, names, projects, drivers, and connection state without exposing credentials.",
        annotations: readOnly,
        inputSchema: {
          project: z.string().optional().describe("Optional exact DBeaver project name."),
          connected_only: z.boolean().optional().describe("Return only currently connected data sources.")
        }
      },
      async (args) => callDBeaverDesktopTool("dbeaver_list_connections", args, bridgeOptions)
    );

    forward(
      "dbeaver_open_sql_editor",
      "Open SQL editor in DBeaver",
      "Open a visible DBeaver SQL console and return its editor ID.",
      uiMutation,
      {
        connection: z.string().min(1).describe("DBeaver connection ID or exact name."),
        project: z.string().optional(),
        database: z.string().optional().describe("Requested database/catalog context; DBeaver defaults remain authoritative."),
        schema: z.string().optional().describe("Requested schema context; DBeaver defaults remain authoritative."),
        title: z.string().optional(),
        sql: z.string().optional()
      }
    );
    forward("dbeaver_insert_sql", "Insert SQL in DBeaver", "Insert SQL at the current editor selection.", uiMutation, {
      editor_id: z.string().min(1),
      sql: z.string().min(1)
    });
    forward("dbeaver_replace_sql", "Replace SQL in DBeaver", "Replace the complete SQL editor document.", uiMutation, {
      editor_id: z.string().min(1),
      sql: z.string(),
      select_all: z.boolean().optional()
    });
    forward("dbeaver_append_sql", "Append SQL in DBeaver", "Append SQL to the end of a visible editor.", uiMutation, {
      editor_id: z.string().min(1),
      sql: z.string().min(1)
    });
    forward("dbeaver_focus_editor", "Focus DBeaver editor", "Activate and focus a known SQL editor without executing anything.", uiMutation, {
      editor_id: z.string().min(1)
    });
    forward("dbeaver_save_sql_snippet", "Save DBeaver SQL snippet", "Open DBeaver's Save As flow for a SQL editor.", uiMutation, {
      editor_id: z.string().min(1)
    });
    forward("dbeaver_select_connection", "Select DBeaver connection", "Change the connection associated with a SQL editor.", uiMutation, {
      editor_id: z.string().min(1),
      connection: z.string().min(1),
      project: z.string().optional()
    });
    reg(
      mcp,
      "dbeaver_propose_sql",
      {
        title: "Propose SQL in DBeaver",
        description: "Create a visible SQL proposal, select it, and return a bounded diff. This never executes SQL. After this tool returns, stop and wait for the user to click Run in the SQL Artifact; never call execution preparation in the same assistant turn.",
        annotations: uiMutation,
        inputSchema: {
          editor_id: z.string().optional(),
          connection: z.string().optional().describe("Needed only when DBeaver must open a new editor."),
          project: z.string().optional(),
          database: z.string().optional(),
          schema: z.string().optional(),
          title: z.string().optional(),
          sql: z.string().min(1)
        },
        _meta: {
          ui: { resourceUri: DBEAVER_SQL_ARTIFACT_URI, visibility: ["model", "app"] },
          "openai/outputTemplate": DBEAVER_SQL_ARTIFACT_URI,
          "openai/widgetAccessible": true,
          "openai/toolInvocation/invoking": "Opening SQL artifact…",
          "openai/toolInvocation/invoked": "SQL proposal ready."
        }
      },
      async (args) => {
        const result = await callDBeaverDesktopTool("dbeaver_propose_sql", args, bridgeOptions);
        const payload = dbeaverToolPayload(result);
        if (!payload?.editor_id) return result;
        const intent = createDBeaverRunIntent(payload, args);
        return {
          ...result,
          _meta: {
            ...(result?._meta || {}),
            dbeaver_run_intent: {
              token: intent.token,
              expires_at: new Date(intent.expiresAtMs).toISOString(),
              editor_id: intent.editorId,
              proposal_id: intent.proposalId
            }
          }
        };
      }
    );
    forward("dbeaver_get_active_editor", "Get active DBeaver editor", "Return active SQL editor identity and connection.", readOnly, {});
    forward("dbeaver_get_current_selection", "Get DBeaver SQL selection", "Return selected SQL and the statement under the cursor.", readOnly, {
      editor_id: z.string().optional()
    });
    reg(
      mcp,
      "dbeaver_prepare_sql_execution",
      {
        title: "Confirm SQL in DBeaver",
        description: "Widget-only action invoked after the user clicks Run in the SQL Artifact. It confirms the exact immutable SQL and connection captured by dbeaver_propose_sql, never the editor cursor or current selection.",
        annotations: uiMutation,
        inputSchema: {
          run_intent_token: z.string().min(1).describe("Hidden, short-lived capability supplied only to the SQL Artifact widget."),
          max_rows: z.number().int().min(1).max(1000).optional(),
          timeout_seconds: z.number().int().min(1).max(300).optional(),
          auto_connect: z.boolean().optional()
        },
        _meta: {
          ui: { visibility: ["app"] },
          "openai/widgetAccessible": true,
          "openai/toolInvocation/invoking": "Waiting for confirmation in DBeaver…",
          "openai/toolInvocation/invoked": "DBeaver confirmation completed."
        }
      },
      async ({ run_intent_token, max_rows, timeout_seconds, auto_connect }) => {
        const intent = requireDBeaverRunIntent(run_intent_token);
        if (intent.status !== "ready") throw new Error("This SQL Artifact Run capability has already been used.");
        if (!intent.connectionId || !intent.sql) {
          throw new Error("The SQL Artifact is missing its captured connection or SQL. Create a fresh proposal.");
        }
        const prepareArgs = {
          connection: intent.connectionId,
          ...(intent.project ? { project: intent.project } : {}),
          sql: intent.sql,
          ...(max_rows !== undefined ? { max_rows } : {}),
          ...(timeout_seconds !== undefined ? { timeout_seconds } : {}),
          ...(auto_connect !== undefined ? { auto_connect } : {})
        };
        const result = await callDBeaverDesktopTool("dbeaver_prepare_sql_execution", prepareArgs, bridgeOptions);
        const payload = dbeaverToolPayload(result);
        if (payload?.approved && payload?.approval_id) {
          intent.status = "approved";
          intent.approvalId = String(payload.approval_id);
        }
        return result;
      }
    );
    reg(
      mcp,
      "dbeaver_execute_sql",
      {
        title: "Execute approved SQL in DBeaver",
        description: "Widget-only action that executes the exact SQL approved in DBeaver. It requires both the native approval ID and the hidden SQL Artifact Run capability.",
        annotations: execution,
        inputSchema: {
          run_intent_token: z.string().min(1).describe("Hidden SQL Artifact capability."),
          approval_id: z.string().min(1)
        },
        _meta: {
          ui: { visibility: ["app"] },
          "openai/widgetAccessible": true,
          "openai/toolInvocation/invoking": "Executing approved SQL…",
          "openai/toolInvocation/invoked": "Approved SQL executed."
        }
      },
      async ({ run_intent_token, approval_id }) => {
        const intent = requireDBeaverRunIntent(run_intent_token);
        if (intent.status !== "approved" || intent.approvalId !== String(approval_id)) {
          throw new Error("The approval ID is not bound to this SQL Artifact Run capability.");
        }
        intent.status = "consumed";
        try {
          return await callDBeaverDesktopTool("dbeaver_execute_sql", { approval_id }, bridgeOptions);
        } finally {
          dbeaverRunIntents.delete(intent.token);
        }
      }
    );
    forward("dbeaver_cancel_sql_execution", "Cancel approved SQL", "Cancel an unused DBeaver SQL approval.", uiMutation, {
      approval_id: z.string().min(1)
    });
    forward("dbeaver_get_last_result", "Get last DBeaver result", "Return result metadata, columns, and a small preview.", readOnly, {});
    forward("dbeaver_fetch_result", "Fetch DBeaver result page", "Fetch a bounded page from a stored SQL result.", readOnly, {
      execution_id: z.string().optional(),
      page: z.number().int().min(1).optional(),
      page_size: z.number().int().min(1).max(200).optional()
    });
    forward("dbeaver_get_last_queries", "Get recent DBeaver operator queries", "Return recent SQL executed through the operator bridge.", readOnly, {
      limit: z.number().int().min(1).max(100).optional()
    });
    forward("dbeaver_get_transaction_status", "Get DBeaver transaction status", "Read editor-scoped transaction state.", readOnly, {
      editor_id: z.string().min(1)
    });
    forward("dbeaver_begin_transaction", "Begin DBeaver transaction", "Disable auto-commit for an editor execution context.", uiMutation, {
      editor_id: z.string().min(1)
    });
    forward("dbeaver_commit", "Commit DBeaver transaction", "Show native confirmation and commit the editor's current transaction.", execution, {
      editor_id: z.string().min(1)
    });
    forward("dbeaver_rollback", "Rollback DBeaver transaction", "Show native confirmation and roll back the editor's current transaction.", execution, {
      editor_id: z.string().min(1)
    });
    forward(
      "dbeaver_simulate_change",
      "Simulate a DBeaver data change",
      "Show native DBeaver confirmation, run one DML statement in an isolated transaction, observe bounded state, and roll it back.",
      execution,
      {
        connection: z.string().min(1),
        project: z.string().optional(),
        sql: z.string().min(1),
        allow_simulation: z.literal(true),
        acknowledge_external_side_effects: z.literal(true),
        observe_object_ids: z.array(z.string()).optional(),
        observation_rows: z.number().int().min(1).max(200).optional(),
        mask_sensitive: z.boolean().optional(),
        timeout_seconds: z.number().int().min(1).max(300).optional(),
        auto_connect: z.boolean().optional()
      }
    );
  }


  return registerDBeaverDesktopTools;
}
