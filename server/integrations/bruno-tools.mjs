import { z } from "zod";
import { brunoDesktopStatus, callBrunoDesktopTool, listBrunoDesktopTools } from "../bruno-desktop.mjs";

export function createBrunoToolRegistrar(options) {
  const { reg, jsonResult, BRUNO_DESKTOP_MCP_URL, BRUNO_DESKTOP_TIMEOUT_MS, BRUNO_DESKTOP_AUTH_TOKEN } = options;

  function registerBrunoDesktopTools(mcp) {
    const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };
    const mutation = { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false };
    const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false };
    const bridgeOptions = {
      endpoint: BRUNO_DESKTOP_MCP_URL,
      timeoutMs: BRUNO_DESKTOP_TIMEOUT_MS,
      authToken: BRUNO_DESKTOP_AUTH_TOKEN
    };
    const workspaceSchema = {
      workspace_uid: z.string().min(1).optional(),
      workspace_path: z.string().min(1).optional()
    };
    const collectionSchema = {
      ...workspaceSchema,
      collection_path: z.string().min(1)
    };
    const requestReferenceSchema = {
      ...workspaceSchema,
      request_uid: z.string().min(1).optional(),
      collection_path: z.string().min(1).optional(),
      item_pathname: z.string().min(1).optional()
    };
    const mutationSchema = {
      definition: z.record(z.string(), z.any()).optional(),
      changes: z.record(z.string(), z.any()).optional(),
      set: z.record(z.string(), z.any()).optional(),
      unset: z.array(z.string().min(1)).optional()
    };
    const executionSchema = {
      ...requestReferenceSchema,
      environment_uid: z.string().min(1).optional(),
      environment_name: z.string().min(1).optional(),
      runtime_variables: z.record(z.string(), z.any()).optional(),
      prompt_variables: z.record(z.string(), z.any()).optional()
    };
    const environmentReferenceSchema = {
      ...collectionSchema,
      environment_uid: z.string().optional(),
      environment_name: z.string().optional(),
      environment_filename: z.string().optional()
    };
    const forward = (name, title, description, annotations, inputSchema) => reg(
      mcp,
      name,
      { title, description, annotations, inputSchema },
      async (args) => callBrunoDesktopTool(name, args, bridgeOptions)
    );

    reg(
      mcp,
      "bruno_status",
      {
        title: "Bruno Desktop status",
        description: "Check whether Bruno Desktop's collection-native MCP is running and list its live tools.",
        annotations: readOnly,
        inputSchema: {}
      },
      async () => jsonResult(await brunoDesktopStatus(bridgeOptions))
    );

    reg(
      mcp,
      "bruno_list_tools",
      {
        title: "List Bruno Desktop tools",
        description: "List every live Bruno MCP tool with its annotations and JSON schema.",
        annotations: readOnly,
        inputSchema: {}
      },
      async () => {
        const result = await listBrunoDesktopTools(bridgeOptions);
        return jsonResult({ endpoint: BRUNO_DESKTOP_MCP_URL, count: result.tools.length, tools: result.tools });
      }
    );

    reg(
      mcp,
      "bruno_call_tool",
      {
        title: "Call any Bruno Desktop tool",
        description: "Forward any currently exposed Bruno Desktop MCP tool without an additional LCA permission, trusted-domain, side-effect, or flow policy layer. Use bruno_list_tools first for the exact upstream schema.",
        annotations: mutation,
        inputSchema: {
          tool: z.string().min(1),
          arguments: z.record(z.any()).optional()
        }
      },
      async ({ tool, arguments: upstreamArguments }) => callBrunoDesktopTool(tool, upstreamArguments || {}, bridgeOptions)
    );

    forward("bruno_list_workspaces", "List Bruno workspaces", "List workspace roots configured for Bruno collection discovery.", readOnly, {});
    forward("bruno_list_collections", "List Bruno collections", "Find Bruno collections under a workspace.", readOnly, { ...workspaceSchema, query: z.string().optional() });
    forward("bruno_get_collection", "Get Bruno collection", "Read a complete collection definition, settings, nested items, and environments.", readOnly, collectionSchema);
    forward("bruno_create_collection", "Create Bruno collection", "Create a .bru or OpenCollection YAML collection.", mutation, {
      ...workspaceSchema,
      location: z.string().optional(),
      name: z.string().min(1),
      folder_name: z.string().optional(),
      format: z.enum(["bru", "yml"]).optional(),
      bruno_config: z.record(z.string(), z.any()).optional(),
      root: z.record(z.string(), z.any()).optional()
    });
    forward("bruno_update_collection", "Update Bruno collection", "Replace, merge, set, or unset any collection root/config field.", mutation, {
      ...collectionSchema,
      name: z.string().optional(),
      ...mutationSchema
    });
    forward("bruno_update_collection_tab", "Update Bruno collection tab", "Edit overview, headers, vars, auth, script, tests, docs, presets, proxy, client-certificates, or protobuf.", mutation, {
      ...collectionSchema,
      tab: z.string().min(1),
      value: z.any()
    });
    forward("bruno_clone_collection", "Clone Bruno collection", "Clone a complete collection including requests, environments, dotenv, and settings.", mutation, {
      ...collectionSchema,
      target_location: z.string().optional(),
      folder_name: z.string().optional(),
      name: z.string().optional()
    });
    forward("bruno_move_collection", "Move Bruno collection", "Move or rename a collection directory and optionally change its display name.", mutation, {
      ...collectionSchema,
      target_location: z.string().optional(),
      folder_name: z.string().optional(),
      name: z.string().optional()
    });
    forward("bruno_delete_collection", "Delete Bruno collection", "Delete a collection directory and all contents.", destructive, collectionSchema);
    forward("bruno_resequence_items", "Resequence Bruno items", "Set request and folder seq values used by the collection sidebar.", mutation, {
      ...collectionSchema,
      items: z.array(z.object({ path: z.string().min(1), seq: z.number() }))
    });
    forward("bruno_list_collection_items", "List Bruno collection items", "Read the complete nested folder/request tree.", readOnly, collectionSchema);

    forward("bruno_get_folder", "Get Bruno folder", "Read a complete folder definition and every Folder Settings tab.", readOnly, { ...collectionSchema, folder_path: z.string() });
    forward("bruno_create_folder", "Create Bruno folder", "Create a folder with an optional complete definition.", mutation, {
      ...collectionSchema,
      parent_path: z.string().optional(),
      folder_name: z.string().min(1),
      name: z.string().optional(),
      seq: z.number().optional(),
      definition: z.record(z.string(), z.any()).optional()
    });
    forward("bruno_update_folder", "Update Bruno folder", "Replace, merge, set, or unset any folder field.", mutation, {
      ...collectionSchema,
      folder_path: z.string(),
      ...mutationSchema
    });
    forward("bruno_update_folder_tab", "Update Bruno folder tab", "Edit headers, vars, auth, script, tests, docs, or settings.", mutation, {
      ...collectionSchema,
      folder_path: z.string(),
      tab: z.string().min(1),
      value: z.any()
    });
    forward("bruno_delete_folder", "Delete Bruno folder", "Delete a folder and all nested requests.", destructive, { ...collectionSchema, folder_path: z.string().min(1) });
    forward("bruno_move_item", "Move Bruno item", "Move or rename a request or folder inside a collection.", mutation, {
      ...collectionSchema,
      source_path: z.string().min(1),
      target_folder: z.string().optional(),
      new_filename: z.string().optional()
    });

    forward("bruno_list_requests", "List Bruno requests", "List requests across a workspace or within one collection.", readOnly, {
      ...workspaceSchema,
      collection_path: z.string().optional(),
      limit: z.number().int().min(1).max(10000).optional()
    });
    forward("bruno_search_requests", "Search Bruno requests", "Search by name, type, method, URL, collection, or pathname.", readOnly, {
      ...workspaceSchema,
      collection_path: z.string().optional(),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(10000).optional()
    });
    forward("bruno_get_request", "Get Bruno request", "Read the complete editable request definition including every persisted tab and field.", readOnly, requestReferenceSchema);
    forward("bruno_create_request", "Create Bruno request", "Create HTTP, GraphQL, gRPC, WebSocket, or SSE request with an optional full definition.", mutation, {
      ...collectionSchema,
      folder_path: z.string().optional(),
      name: z.string().min(1),
      filename: z.string().optional(),
      type: z.string().optional(),
      method: z.string().optional(),
      url: z.string().optional(),
      seq: z.number().optional(),
      definition: z.record(z.string(), z.any()).optional()
    });
    forward("bruno_update_request", "Update Bruno request", "Universal request editor: replace, deep-merge, set, unset, rename, or move any current or future field.", mutation, {
      ...requestReferenceSchema,
      name: z.string().optional(),
      new_item_pathname: z.string().optional(),
      ...mutationSchema
    });
    forward("bruno_update_request_tab", "Update Bruno request tab", "Edit params, body, headers/metadata, auth, vars, script, assert, tests, docs, query, message, examples, app, or settings.", mutation, {
      ...requestReferenceSchema,
      tab: z.string().min(1),
      value: z.any()
    });
    forward("bruno_duplicate_request", "Duplicate Bruno request", "Duplicate a request with every tab and example preserved.", mutation, {
      ...requestReferenceSchema,
      name: z.string().optional(),
      filename: z.string().optional(),
      folder_path: z.string().optional()
    });
    forward("bruno_delete_request", "Delete Bruno request", "Delete a request file.", destructive, requestReferenceSchema);

    forward("bruno_list_environments", "List Bruno environments", "List complete collection environments and variable definitions.", readOnly, collectionSchema);
    forward("bruno_get_environment", "Get Bruno environment", "Read one complete environment definition.", readOnly, environmentReferenceSchema);
    forward("bruno_create_environment", "Create Bruno environment", "Create an environment including typed, described, annotated, colored, and secret variables.", mutation, {
      ...collectionSchema,
      name: z.string().min(1),
      filename: z.string().optional(),
      definition: z.record(z.string(), z.any()).optional()
    });
    forward("bruno_update_environment", "Update Bruno environment", "Replace, merge, set, unset, rename, or move any environment field or variable.", mutation, {
      ...environmentReferenceSchema,
      name: z.string().optional(),
      new_filename: z.string().optional(),
      ...mutationSchema
    });
    forward("bruno_delete_environment", "Delete Bruno environment", "Delete a collection environment.", destructive, environmentReferenceSchema);

    forward("bruno_get_dotenv", "Get Bruno dotenv", "Read a collection .env file as raw content and parsed variables.", readOnly, { ...collectionSchema, filename: z.string().optional() });
    forward("bruno_set_dotenv", "Set Bruno dotenv", "Create or replace a collection .env file from raw content or variables.", mutation, {
      ...collectionSchema,
      filename: z.string().optional(),
      content: z.string().optional(),
      variables: z.record(z.string(), z.any()).optional()
    });
    forward("bruno_delete_dotenv", "Delete Bruno dotenv", "Delete a collection .env file.", destructive, { ...collectionSchema, filename: z.string().optional() });

    forward("bruno_prepare_request", "Prepare Bruno request", "Resolve normal Bruno collection, folder, environment, dotenv, runtime, and prompt-variable precedence without sending.", readOnly, executionSchema);
    forward("bruno_run_request", "Run Bruno request", "Run any Bruno request through the normal desktop engine and return the complete stored result. No separate LCA side-effect approval is added.", mutation, {
      ...executionSchema,
      run_id: z.string().optional(),
      correlation_id: z.string().optional(),
      wait_mode: z.enum(["start", "complete"]).optional()
    });
    forward("bruno_get_request_run", "Get Bruno request run", "Read a previously started request run and its complete result.", readOnly, { run_id: z.string().min(1) });
    forward("bruno_list_request_runs", "List Bruno request runs", "List request runs retained by the current Bruno Desktop process.", readOnly, { limit: z.number().int().min(1).max(1000).optional() });
  }


  return registerBrunoDesktopTools;
}
