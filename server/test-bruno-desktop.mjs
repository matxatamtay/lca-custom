// Local Coding Agent Bruno Desktop MCP bridge tests
// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  brunoDesktopStatus,
  callBrunoDesktopTool,
  listBrunoDesktopTools,
  normalizeBrunoDesktopEndpoint
} from "./bruno-desktop.mjs";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(SERVER_DIR, "server.mjs");
const BRIDGE_CREDENTIAL = ["mock", "bruno", "local", "credential"].join("-");
const UPSTREAM_TOOLS = [
  "bruno_status",
  "bruno_list_workspaces",
  "bruno_list_collections",
  "bruno_get_collection",
  "bruno_create_collection",
  "bruno_update_collection",
  "bruno_update_collection_tab",
  "bruno_clone_collection",
  "bruno_move_collection",
  "bruno_delete_collection",
  "bruno_resequence_items",
  "bruno_list_collection_items",
  "bruno_get_folder",
  "bruno_create_folder",
  "bruno_update_folder",
  "bruno_update_folder_tab",
  "bruno_delete_folder",
  "bruno_move_item",
  "bruno_list_requests",
  "bruno_search_requests",
  "bruno_get_request",
  "bruno_create_request",
  "bruno_update_request",
  "bruno_update_request_tab",
  "bruno_duplicate_request",
  "bruno_delete_request",
  "bruno_list_environments",
  "bruno_get_environment",
  "bruno_create_environment",
  "bruno_update_environment",
  "bruno_delete_environment",
  "bruno_get_dotenv",
  "bruno_set_dotenv",
  "bruno_delete_dotenv",
  "bruno_prepare_request",
  "bruno_run_request",
  "bruno_get_request_run",
  "bruno_list_request_runs"
];
const READ_ONLY_TOOLS = new Set([
  "bruno_status",
  "bruno_list_workspaces",
  "bruno_list_collections",
  "bruno_get_collection",
  "bruno_list_collection_items",
  "bruno_get_folder",
  "bruno_list_requests",
  "bruno_search_requests",
  "bruno_get_request",
  "bruno_list_environments",
  "bruno_get_environment",
  "bruno_get_dotenv",
  "bruno_prepare_request",
  "bruno_get_request_run",
  "bruno_list_request_runs"
]);
const DESTRUCTIVE_TOOLS = new Set([
  "bruno_delete_collection",
  "bruno_delete_folder",
  "bruno_delete_request",
  "bruno_delete_environment",
  "bruno_delete_dotenv"
]);
let pass = 0;
let fail = 0;

function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    console.error(`[FAIL] ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

function createMockBruno(calls) {
  const mcp = new McpServer({ name: "Mock Bruno Desktop", version: "2.0.0" });
  const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const handler = (tool) => async (args) => {
    calls.push({ tool, args });
    if (tool === "bruno_status") return result({ status: "ok", capabilities: { collections: "full-crud", requests: "full-crud", flow_studio: false, intelligence_suite: false } });
    if (tool === "bruno_list_workspaces") return result({ workspaces: [{ uid: "workspace_demo", path: "/workspace/demo" }] });
    if (tool === "bruno_list_collections") return result({ collections: [{ name: "Demo API", collection_path: "demo" }] });
    if (tool === "bruno_get_request") return result({ name: "Get user", item_pathname: "users/get-user.bru", definition: { name: "Get user", request: { vars: { req: [{ name: "userId", value: "1" }] }, body: { mode: "json", json: "{}" } } } });
    if (tool === "bruno_update_request") return result({ name: args.name || "Updated request", item_pathname: args.new_item_pathname || args.item_pathname, definition: { ...(args.changes || {}), name: args.name || "Updated request" } });
    if (tool === "bruno_update_request_tab") return result({ updated: true, tab: args.tab, value: args.value });
    if (tool === "bruno_create_collection") return result({ name: args.name, collection_path: args.folder_name || "created" });
    if (tool === "bruno_create_folder") return result({ folder_path: args.folder_name, definition: { meta: { name: args.name || args.folder_name } } });
    if (tool === "bruno_create_environment") return result({ environment: { name: args.name, definition: args.definition || { variables: [] } } });
    if (tool === "bruno_set_dotenv") return result({ filename: args.filename || ".env", variables: args.variables || {} });
    if (tool === "bruno_prepare_request") return result({ ready: true, prepared_request: { method: "POST", url: "https://api.test/users" }, runtime_variables: args.runtime_variables || {} });
    if (tool === "bruno_run_request") return result({ run_id: args.run_id || "run_demo", status: "success", result: { response: { status: 201, body: { id: "usr_1" } }, tests: [{ status: "pass" }] } });
    if (tool === "bruno_get_request_run") return result({ run_id: args.run_id, status: "success", result: { response: { status: 201 } } });
    if (tool === "bruno_delete_request") return result({ deleted: true, item_pathname: args.item_pathname });
    return result({ ok: true, tool, args });
  };

  const inputSchema = {
    workspace_uid: z.string().optional(),
    workspace_path: z.string().optional(),
    collection_path: z.string().optional(),
    item_pathname: z.string().optional(),
    request_uid: z.string().optional(),
    folder_path: z.string().optional(),
    parent_path: z.string().optional(),
    source_path: z.string().optional(),
    target_folder: z.string().optional(),
    target_location: z.string().optional(),
    location: z.string().optional(),
    environment_uid: z.string().optional(),
    environment_name: z.string().optional(),
    environment_filename: z.string().optional(),
    name: z.string().optional(),
    folder_name: z.string().optional(),
    filename: z.string().optional(),
    new_filename: z.string().optional(),
    new_item_pathname: z.string().optional(),
    type: z.string().optional(),
    method: z.string().optional(),
    url: z.string().optional(),
    format: z.string().optional(),
    tab: z.string().optional(),
    value: z.any().optional(),
    definition: z.record(z.any()).optional(),
    changes: z.record(z.any()).optional(),
    set: z.record(z.any()).optional(),
    unset: z.array(z.string()).optional(),
    variables: z.record(z.any()).optional(),
    content: z.string().optional(),
    runtime_variables: z.record(z.any()).optional(),
    prompt_variables: z.record(z.any()).optional(),
    run_id: z.string().optional(),
    correlation_id: z.string().optional(),
    wait_mode: z.string().optional(),
    query: z.string().optional(),
    limit: z.number().optional(),
    seq: z.number().optional(),
    items: z.array(z.any()).optional(),
    bruno_config: z.record(z.any()).optional(),
    root: z.record(z.any()).optional()
  };

  for (const tool of UPSTREAM_TOOLS) {
    mcp.registerTool(tool, {
      description: tool,
      annotations: {
        readOnlyHint: READ_ONLY_TOOLS.has(tool),
        destructiveHint: DESTRUCTIVE_TOOLS.has(tool),
        idempotentHint: READ_ONLY_TOOLS.has(tool)
      },
      inputSchema
    }, handler(tool));
  }
  return mcp;
}

async function startMockBruno() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.url !== "/mcp" || req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${BRIDGE_CREDENTIAL}`) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }));
      return;
    }
    const mcp = createMockBruno(calls);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, await readJsonBody(req));
  });
  const port = await getFreePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, calls, endpoint: `http://127.0.0.1:${port}/mcp` };
}

async function waitForHealth(port, stderrRef) {
  for (let index = 0; index < 100; index++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error(`LCA did not become ready on port ${port}\n${stderrRef.value}`);
}

async function startLca(workspace, endpoint, policy = "strict") {
  await mkdir(workspace, { recursive: true });
  const port = await getFreePort();
  const stderrRef = { value: "" };
  const child = spawn(process.execPath, [SERVER], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_WORKSPACE: workspace,
      AGENT_MODE: "safe",
      AGENT_POLICY: policy,
      AGENT_EXTRA_ROOTS_JSON: "[]",
      AGENT_AUDIT: "0",
      MCP_AUTH_TOKEN: "",
      BRUNO_DESKTOP_MCP_URL: endpoint,
      BRUNO_DESKTOP_AUTH_TOKEN: BRIDGE_CREDENTIAL,
      BRUNO_DESKTOP_TIMEOUT_MS: "10000"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (chunk) => (stderrRef.value += chunk));
  await waitForHealth(port, stderrRef);
  return { child, port };
}

async function stopChild(child) {
  if (!child?.pid) return;
  child.kill("SIGTERM");
  await wait(300);
}

async function connect(port) {
  const client = new Client({ name: "bruno-bridge-test", version: "2.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

async function callRaw(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

async function call(client, name, args = {}) {
  const response = await callRaw(client, name, args);
  if (response.isError) throw new Error(response.content?.[0]?.text || `${name} failed`);
  return response;
}

function payload(response) {
  const text = response?.content?.find?.((entry) => entry.type === "text")?.text;
  return text ? JSON.parse(text) : {};
}

const base = await mkdtemp(path.join(os.tmpdir(), "lca-bruno-collection-mcp-"));
const mock = await startMockBruno();
let lca;
let client;
try {
  check("default Bruno endpoint is loopback", normalizeBrunoDesktopEndpoint().includes("127.0.0.1:3847"));
  let rejectedRemote = false;
  try {
    normalizeBrunoDesktopEndpoint("https://example.com/mcp");
  } catch (error) {
    rejectedRemote = /loopback/.test(error.message);
  }
  check("Bruno bridge rejects accidental remote endpoints", rejectedRemote);

  const directOptions = { endpoint: mock.endpoint, authToken: BRIDGE_CREDENTIAL, timeoutMs: 10000 };
  const status = await brunoDesktopStatus(directOptions);
  check("bridge connects to collection-native Bruno MCP", status.connected && status.tool_count === 38 && status.surface === "collections", JSON.stringify(status));
  const listed = await listBrunoDesktopTools(directOptions);
  check("bridge sees all 38 upstream tools", listed.tools.length === 38 && UPSTREAM_TOOLS.every((name) => listed.tools.some((tool) => tool.name === name)), JSON.stringify(listed.tools));
  check("upstream surface excludes Flow Studio and Intelligence Suite", !listed.tools.some((tool) => /flow|intelligence/i.test(tool.name)), JSON.stringify(listed.tools));

  const directMutation = await callBrunoDesktopTool("bruno_update_request", {
    workspace_uid: "workspace_demo",
    collection_path: "demo",
    item_pathname: "users/get-user.bru",
    name: "Get user edited",
    set: { "request.vars.req": [{ name: "userId", value: "42" }] }
  }, directOptions);
  check("direct bridge forwards request mutations", /Get user edited/.test(directMutation.content?.[0]?.text || ""), JSON.stringify(directMutation));

  lca = await startLca(path.join(base, "workspace"), mock.endpoint, "strict");
  client = await connect(lca.port);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  check("LCA exposes every Bruno collection tool", UPSTREAM_TOOLS.every((name) => names.has(name)), JSON.stringify([...names].filter((name) => name.startsWith("bruno_"))));
  check("LCA adds live discovery and unrestricted passthrough", names.has("bruno_list_tools") && names.has("bruno_call_tool"));
  check("LCA exposes no obsolete Flow Studio tools", ![...names].some((name) => /^bruno_.*flow/.test(name)), JSON.stringify([...names]));

  const collection = await call(client, "bruno_create_collection", {
    workspace_path: "/workspace/demo",
    name: "Created API",
    folder_name: "created-api"
  });
  check("strict LCA policy does not gate Bruno collection mutations", payload(collection).name === "Created API", JSON.stringify(collection));

  const folder = await call(client, "bruno_create_folder", {
    workspace_uid: "workspace_demo",
    collection_path: "demo",
    folder_name: "admin",
    name: "Admin"
  });
  check("LCA forwards folder CRUD", payload(folder).definition?.meta?.name === "Admin", JSON.stringify(folder));

  const request = await call(client, "bruno_get_request", {
    workspace_uid: "workspace_demo",
    collection_path: "demo",
    item_pathname: "users/get-user.bru"
  });
  check("LCA returns complete editable request definitions", payload(request).definition?.request?.vars?.req?.[0]?.name === "userId", JSON.stringify(request));

  const updated = await call(client, "bruno_update_request", {
    workspace_uid: "workspace_demo",
    collection_path: "demo",
    item_pathname: "users/get-user.bru",
    name: "Get user edited",
    new_item_pathname: "users/get-user-edited.bru",
    set: {
      "request.vars.req": [{ name: "userId", value: "42", enabled: true }],
      "request.auth": { mode: "bearer", bearer: { token: "{{token}}" } }
    }
  });
  check("LCA forwards universal request edits", payload(updated).name === "Get user edited", JSON.stringify(updated));

  const tab = await call(client, "bruno_update_request_tab", {
    workspace_uid: "workspace_demo",
    collection_path: "demo",
    item_pathname: "users/get-user.bru",
    tab: "body",
    value: { mode: "json", json: "{\"name\":\"Ada\"}" }
  });
  check("LCA forwards per-tab request edits", payload(tab).tab === "body", JSON.stringify(tab));

  const environment = await call(client, "bruno_create_environment", {
    workspace_uid: "workspace_demo",
    collection_path: "demo",
    name: "Local",
    definition: { variables: [{ name: "baseUrl", value: "https://api.test", enabled: true }] }
  });
  check("LCA forwards environment CRUD", payload(environment).environment?.name === "Local", JSON.stringify(environment));

  const dotenv = await call(client, "bruno_set_dotenv", {
    workspace_uid: "workspace_demo",
    collection_path: "demo",
    variables: { TOKEN: "local" }
  });
  check("LCA forwards dotenv CRUD", payload(dotenv).variables?.TOKEN === "local", JSON.stringify(dotenv));

  const prepared = await call(client, "bruno_prepare_request", {
    workspace_uid: "workspace_demo",
    collection_path: "demo",
    item_pathname: "users/get-user.bru",
    environment_name: "Local",
    runtime_variables: { userId: "42" }
  });
  check("LCA resolves Bruno request context", payload(prepared).prepared_request?.method === "POST", JSON.stringify(prepared));

  const run = await call(client, "bruno_run_request", {
    workspace_uid: "workspace_demo",
    collection_path: "demo",
    item_pathname: "users/get-user.bru",
    environment_name: "Local",
    runtime_variables: { userId: "42" },
    wait_mode: "complete"
  });
  check("strict LCA policy does not gate POST request execution", payload(run).result?.response?.status === 201, JSON.stringify(run));

  const storedRun = await call(client, "bruno_get_request_run", { run_id: "run_demo" });
  check("LCA retrieves stored Bruno run results", payload(storedRun).result?.response?.status === 201, JSON.stringify(storedRun));

  const genericMutation = await call(client, "bruno_call_tool", {
    tool: "bruno_delete_request",
    arguments: {
      workspace_uid: "workspace_demo",
      collection_path: "demo",
      item_pathname: "users/get-user.bru"
    }
  });
  check("generic passthrough forwards mutations without a read-only gate", payload(genericMutation).deleted === true, JSON.stringify(genericMutation));

  check("mock received detailed request fields unchanged", mock.calls.some((entry) =>
    entry.tool === "bruno_update_request"
    && entry.args.set?.["request.vars.req"]?.[0]?.value === "42"
    && entry.args.set?.["request.auth"]?.mode === "bearer"
  ), JSON.stringify(mock.calls));
} finally {
  await client?.close().catch(() => {});
  await stopChild(lca?.child);
  await new Promise((resolve) => mock.server.close(resolve));
  await rm(base, { recursive: true, force: true });
}

process.stdout.write(`\nBruno collection bridge tests: ${pass} passed, ${fail} failed\n`);
if (fail) process.exitCode = 1;
