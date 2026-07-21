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
  applyApprovedBrunoFlowPatch,
  brunoDesktopStatus,
  callBrunoDesktopTool,
  callReadOnlyBrunoDesktopTool,
  listBrunoDesktopTools,
  normalizeBrunoDesktopEndpoint,
  previewBrunoFlowPatch
} from "./bruno-desktop.mjs";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(SERVER_DIR, "server.mjs");
const AUTH_TOKEN = "mock-bruno-token";
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
  const mcp = new McpServer({ name: "Mock Bruno Desktop", version: "1.0.0" });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  const mutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };
  const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

  mcp.registerTool("bruno_status", { description: "Status", annotations: readOnly, inputSchema: {} }, async () => result({ status: "ok" }));
  mcp.registerTool("bruno_list_workspaces", { description: "Workspaces", annotations: readOnly, inputSchema: {} }, async () => result({ workspaces: [{ uid: "workspace_demo", name: "Demo" }] }));
  mcp.registerTool("bruno_search_requests", {
    description: "Search requests",
    annotations: readOnly,
    inputSchema: { workspace_uid: z.string(), query: z.string(), limit: z.number().optional() }
  }, async (args) => {
    calls.push({ tool: "bruno_search_requests", args });
    return result({ requests: [{ uid: "request_demo", name: "Get user", method: "GET" }] });
  });
  mcp.registerTool("bruno_get_request", {
    description: "Get request",
    annotations: readOnly,
    inputSchema: { workspace_uid: z.string(), request_uid: z.string() }
  }, async (args) => {
    calls.push({ tool: "bruno_get_request", args });
    return result({ uid: args.request_uid, name: "Get user", definition: { headers: [{ name: "Authorization", value: "[REDACTED]" }] } });
  });
  mcp.registerTool("bruno_list_flows", {
    description: "List flows",
    annotations: readOnly,
    inputSchema: { workspace_uid: z.string() }
  }, async () => result({ flows: [{ uid: "flow_demo", name: "Demo flow", revision: "sha256:old" }] }));
  mcp.registerTool("bruno_get_flow", {
    description: "Get flow",
    annotations: readOnly,
    inputSchema: { workspace_uid: z.string(), flow_uid: z.string() }
  }, async () => result({ flow: { uid: "flow_demo", name: "Demo flow" }, revision: "sha256:old" }));
  mcp.registerTool("bruno_prepare_request", {
    description: "Prepare request",
    annotations: readOnly,
    inputSchema: {
      workspace_uid: z.string(),
      request_uid: z.string(),
      environment_name: z.string().optional(),
      runtime_variables: z.record(z.any()).optional(),
      prompt_variables: z.record(z.any()).optional()
    }
  }, async (args) => {
    calls.push({ tool: "bruno_prepare_request", args });
    return result({
      side_effect: "read-only",
      ready: true,
      resolved_url: "https://api.test/users",
      selected_environment: { name: args.environment_name || "Local" }
    });
  });
  mcp.registerTool("bruno_prepare_flow_run", {
    description: "Prepare flow",
    annotations: readOnly,
    inputSchema: { workspace_uid: z.string(), flow_uid: z.string() }
  }, async (args) => {
    calls.push({ tool: "bruno_prepare_flow_run", args });
    return result({ valid: true, flow_uid: args.flow_uid, side_effect_summary: { once_only_nodes: [] } });
  });
  mcp.registerTool("bruno_preview_resolved_request", {
    description: "Preview resolved request",
    annotations: readOnly,
    inputSchema: { workspace_uid: z.string(), flow_uid: z.string(), node_id: z.string(), inputs: z.record(z.any()).optional() }
  }, async () => result({ preview: { headers: { Authorization: "[REDACTED]" } } }));
  mcp.registerTool("bruno_get_run", {
    description: "Get run",
    annotations: readOnly,
    inputSchema: { run_id: z.string() }
  }, async (args) => result({ run_id: args.run_id, status: "running" }));
  mcp.registerTool("bruno_get_run_events", {
    description: "Get run events",
    annotations: readOnly,
    inputSchema: { run_id: z.string(), after_sequence: z.number().optional(), limit: z.number().optional() }
  }, async (args) => result({ run_id: args.run_id, events: [] }));
  mcp.registerTool("bruno_run_request", {
    description: "Run request",
    annotations: mutation,
    inputSchema: {
      workspace_uid: z.string(),
      request_uid: z.string(),
      environment_name: z.string().optional(),
      runtime_variables: z.record(z.any()).optional(),
      prompt_variables: z.record(z.any()).optional(),
      correlation_id: z.string().optional(),
      allow_side_effects: z.boolean().optional()
    }
  }, async (args) => {
    calls.push({ tool: "bruno_run_request", args });
    return result({
      status: "success",
      response: { status: 200, body: { token: "[REDACTED]", visible: "ok" } },
      request_context: {
        selected_environment: { name: args.environment_name || "Local" },
        runtime_variable_names: Object.keys(args.runtime_variables || {})
      }
    });
  });
  mcp.registerTool("bruno_run_flow", {
    description: "Run flow",
    annotations: mutation,
    inputSchema: { workspace_uid: z.string(), flow_uid: z.string(), wait_mode: z.enum(["start", "complete"]).optional(), inputs: z.record(z.any()).optional() }
  }, async (args) => {
    calls.push({ tool: "bruno_run_flow", args });
    return result({ run_id: "run_demo", flow_uid: args.flow_uid, status: "running", resource: "bruno://run/run_demo" });
  });
  mcp.registerTool("bruno_cancel_run", {
    description: "Cancel run",
    annotations: mutation,
    inputSchema: { run_id: z.string() }
  }, async (args) => {
    calls.push({ tool: "bruno_cancel_run", args });
    return result({ run_id: args.run_id, cancelled: true });
  });
  mcp.registerTool("bruno_preview_flow_patch", {
    description: "Preview patch",
    annotations: readOnly,
    inputSchema: {
      workspace_uid: z.string(),
      flow_uid: z.string(),
      expected_revision: z.string(),
      operations: z.array(z.object({ op: z.string(), path: z.string(), value: z.any().optional() }))
    }
  }, async (args) => {
    calls.push({ tool: "bruno_preview_flow_patch", args });
    return result({ valid: true, preview_id: "preview_demo", expected_revision: args.expected_revision, proposed_revision: "sha256:new" });
  });
  mcp.registerTool("bruno_apply_flow_patch", {
    description: "Apply patch",
    annotations: mutation,
    inputSchema: {
      workspace_uid: z.string(),
      flow_uid: z.string(),
      expected_revision: z.string(),
      preview_id: z.string(),
      approved: z.literal(true),
      operations: z.array(z.object({ op: z.string(), path: z.string(), value: z.any().optional() }))
    }
  }, async (args) => {
    calls.push({ tool: "bruno_apply_flow_patch", args });
    return result({ applied: true, previous_revision: args.expected_revision, revision: "sha256:new" });
  });
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
    if (req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
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

async function startLca(workspace, endpoint, policy = "full") {
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
      BRUNO_DESKTOP_AUTH_TOKEN: AUTH_TOKEN,
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
  const client = new Client({ name: "bruno-bridge-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

async function callRaw(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

async function call(client, name, args = {}) {
  const result = await callRaw(client, name, args);
  if (result.isError) throw new Error(result.content?.[0]?.text || `${name} failed`);
  return result;
}

function payload(result) {
  const text = result?.content?.find?.((entry) => entry.type === "text")?.text;
  return text ? JSON.parse(text) : {};
}

const base = await mkdtemp(path.join(os.tmpdir(), "lca-bruno-desktop-"));
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
  check("Bruno bridge rejects remote endpoints by default", rejectedRemote);

  const directOptions = { endpoint: mock.endpoint, authToken: AUTH_TOKEN, timeoutMs: 10000 };
  const status = await brunoDesktopStatus(directOptions);
  check("bridge connects to mock Bruno MCP", status.connected && status.tools.includes("bruno_run_flow"), JSON.stringify(status));
  const listed = await listBrunoDesktopTools(directOptions);
  check("bridge lists Bruno schemas and annotations", listed.tools.some((tool) => tool.name === "bruno_get_request" && tool.inputSchema && tool.annotations?.readOnlyHint), JSON.stringify(listed.tools));
  const request = await callBrunoDesktopTool("bruno_get_request", { workspace_uid: "workspace_demo", request_uid: "request_demo" }, directOptions);
  check("bridge reads redacted Bruno requests", /\[REDACTED\]/.test(request.content?.[0]?.text || ""), JSON.stringify(request));
  const prepared = await callBrunoDesktopTool("bruno_prepare_flow_run", { workspace_uid: "workspace_demo", flow_uid: "flow_demo" }, directOptions);
  check("bridge previews flow runs", /once_only_nodes/.test(prepared.content?.[0]?.text || ""), JSON.stringify(prepared));
  const run = await callBrunoDesktopTool("bruno_run_flow", { workspace_uid: "workspace_demo", flow_uid: "flow_demo", wait_mode: "start" }, directOptions);
  check("bridge runs flows", /run_demo/.test(run.content?.[0]?.text || ""), JSON.stringify(run));
  const cancelled = await callBrunoDesktopTool("bruno_cancel_run", { run_id: "run_demo" }, directOptions);
  check("bridge cancels flows", /cancelled/.test(cancelled.content?.[0]?.text || ""), JSON.stringify(cancelled));
  const readOnlyRequest = await callReadOnlyBrunoDesktopTool("bruno_get_request", { workspace_uid: "workspace_demo", request_uid: "request_demo" }, directOptions);
  check("generic bridge forwards declared read-only tools", /Get user/.test(readOnlyRequest.content?.[0]?.text || ""), JSON.stringify(readOnlyRequest));
  let blockedGenericRun = false;
  try {
    await callReadOnlyBrunoDesktopTool("bruno_run_flow", { workspace_uid: "workspace_demo", flow_uid: "flow_demo" }, directOptions);
  } catch (error) {
    blockedGenericRun = /not declared read-only/.test(error.message);
  }
  check("generic bridge cannot bypass Bruno execution policy", blockedGenericRun);
  const directPreview = await previewBrunoFlowPatch({
    workspace_uid: "workspace_demo",
    flow_uid: "flow_demo",
    expected_revision: "sha256:old",
    operations: [{ op: "replace", path: "/name", value: "Patched" }]
  }, directOptions);
  check("bridge previews revision-safe patches", /preview_demo/.test(directPreview.content?.[0]?.text || ""), JSON.stringify(directPreview));
  let blockedUnapproved = false;
  try {
    await applyApprovedBrunoFlowPatch({ preview_id: "preview_demo", expected_revision: "sha256:old", operations: [], approved: false }, directOptions);
  } catch (error) {
    blockedUnapproved = /approved=true/.test(error.message);
  }
  check("direct apply wrapper requires explicit approval", blockedUnapproved);

  const offlinePort = await getFreePort();
  const offline = await brunoDesktopStatus({ endpoint: `http://127.0.0.1:${offlinePort}/mcp`, authToken: AUTH_TOKEN, timeoutMs: 1000 });
  check("Bruno off returns a friendly error", offline.connected === false && /not running|Open Bruno/.test(offline.error), JSON.stringify(offline));

  lca = await startLca(path.join(base, "workspace"), mock.endpoint);
  client = await connect(lca.port);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const name of [
    "bruno_status",
    "bruno_list_tools",
    "bruno_call_tool",
    "bruno_get_request",
    "bruno_prepare_request",
    "bruno_run_request",
    "bruno_prepare_flow_run",
    "bruno_run_flow",
    "bruno_cancel_run",
    "bruno_preview_flow_patch",
    "bruno_apply_flow_patch"
  ]) {
    check(`${name} is exposed by LCA`, names.has(name), JSON.stringify([...names]));
  }

  const lcaRequest = await call(client, "bruno_get_request", { workspace_uid: "workspace_demo", request_uid: "request_demo" });
  check("LCA reads Bruno requests", /Get user/.test(lcaRequest.content?.[0]?.text || ""), JSON.stringify(lcaRequest));
  const lcaRequestPrepare = await call(client, "bruno_prepare_request", {
    workspace_uid: "workspace_demo",
    request_uid: "request_demo",
    environment_name: "Local",
    runtime_variables: { user_id: "usr_42" }
  });
  check("LCA resolves Bruno request execution context", payload(lcaRequestPrepare).resolved_url === "https://api.test/users", JSON.stringify(lcaRequestPrepare));
  const lcaRequestRun = await call(client, "bruno_run_request", {
    workspace_uid: "workspace_demo",
    request_uid: "request_demo",
    environment_name: "Local",
    runtime_variables: { user_id: "usr_42" }
  });
  check("LCA runs safe Bruno requests and receives response bodies", payload(lcaRequestRun).response?.body?.visible === "ok", JSON.stringify(lcaRequestRun));
  check("LCA forwards environment and runtime variables to Bruno", mock.calls.some((entry) =>
    entry.tool === "bruno_run_request"
    && entry.args.environment_name === "Local"
    && entry.args.runtime_variables?.user_id === "usr_42"
  ), JSON.stringify(mock.calls));

  const lcaPrepare = await call(client, "bruno_prepare_flow_run", { workspace_uid: "workspace_demo", flow_uid: "flow_demo" });
  check("LCA previews Bruno flow runs", payload(lcaPrepare).valid === true, JSON.stringify(lcaPrepare));
  const lcaRun = await call(client, "bruno_run_flow", { workspace_uid: "workspace_demo", flow_uid: "flow_demo", wait_mode: "start" });
  check("LCA runs Bruno flows", payload(lcaRun).run_id === "run_demo", JSON.stringify(lcaRun));
  const lcaCancel = await call(client, "bruno_cancel_run", { run_id: "run_demo" });
  check("LCA cancels Bruno flows", payload(lcaCancel).cancelled === true, JSON.stringify(lcaCancel));
  const genericBlocked = await callRaw(client, "bruno_call_tool", {
    tool: "bruno_run_flow",
    arguments: { workspace_uid: "workspace_demo", flow_uid: "flow_demo" }
  });
  check("LCA generic passthrough rejects execution tools", genericBlocked.isError === true && /not declared read-only/.test(genericBlocked.content?.[0]?.text || ""), JSON.stringify(genericBlocked));
  const genericRead = await call(client, "bruno_call_tool", {
    tool: "bruno_get_request",
    arguments: { workspace_uid: "workspace_demo", request_uid: "request_demo" }
  });
  check("LCA generic passthrough keeps read-only discovery", /Get user/.test(genericRead.content?.[0]?.text || ""), JSON.stringify(genericRead));

  const operations = [{ op: "replace", path: "/name", value: "Patched" }];
  const patchPreview = await call(client, "bruno_preview_flow_patch", {
    workspace_uid: "workspace_demo",
    flow_uid: "flow_demo",
    expected_revision: "sha256:old",
    operations
  });
  const patchToken = patchPreview?._meta?.bruno_patch_intent?.token || "";
  check("LCA patch preview returns a short-lived bound intent", Boolean(patchToken), JSON.stringify(patchPreview));
  check("patch intent is absent from model-visible content", !String(patchPreview.content?.[0]?.text || "").includes(patchToken), JSON.stringify(patchPreview));

  const mismatchedApply = await callRaw(client, "bruno_apply_flow_patch", {
    patch_intent_token: patchToken,
    approved: true,
    workspace_uid: "workspace_demo",
    flow_uid: "flow_demo",
    expected_revision: "sha256:old",
    operations: [{ ...operations[0], value: "Different" }]
  });
  check("LCA blocks patch operation tampering after preview", mismatchedApply.isError === true && /does not match/.test(mismatchedApply.content?.[0]?.text || ""), JSON.stringify(mismatchedApply));
  const applied = await call(client, "bruno_apply_flow_patch", {
    patch_intent_token: patchToken,
    approved: true,
    workspace_uid: "workspace_demo",
    flow_uid: "flow_demo",
    expected_revision: "sha256:old",
    operations
  });
  check("LCA applies the exact approved revision-safe patch", payload(applied).revision === "sha256:new", JSON.stringify(applied));
  check("mock received preview ID but not the LCA capability", mock.calls.some((entry) =>
    entry.tool === "bruno_apply_flow_patch" &&
    entry.args.preview_id === "preview_demo" &&
    !Object.hasOwn(entry.args, "patch_intent_token")
  ), JSON.stringify(mock.calls));

  await client.close();
  client = null;
  await stopChild(lca.child);
  lca = null;

  lca = await startLca(path.join(base, "strict-workspace"), mock.endpoint, "strict");
  client = await connect(lca.port);
  const strictRead = await call(client, "bruno_get_request", { workspace_uid: "workspace_demo", request_uid: "request_demo" });
  check("strict policy keeps Bruno reads available", /Get user/.test(strictRead.content?.[0]?.text || ""), JSON.stringify(strictRead));
  const strictRun = await callRaw(client, "bruno_run_flow", { workspace_uid: "workspace_demo", flow_uid: "flow_demo", wait_mode: "start" });
  check("strict policy blocks Bruno execution", strictRun.isError === true && /policy=strict/.test(strictRun.content?.[0]?.text || ""), JSON.stringify(strictRun));

  await client.close();
  client = null;
  await stopChild(lca.child);
  lca = null;

  lca = await startLca(path.join(base, "balanced-workspace"), mock.endpoint, "balanced");
  client = await connect(lca.port);
  const balancedSafeRun = await call(client, "bruno_run_request", {
    workspace_uid: "workspace_demo",
    request_uid: "request_demo"
  });
  check("balanced policy lets safe Bruno requests run autonomously", payload(balancedSafeRun).status === "success", JSON.stringify(balancedSafeRun));
  const balancedSideEffectRun = await callRaw(client, "bruno_run_request", {
    workspace_uid: "workspace_demo",
    request_uid: "request_demo",
    allow_side_effects: true
  });
  check("balanced policy requires approval for side-effect opt-in", balancedSideEffectRun.isError === true && /Approval required/.test(balancedSideEffectRun.content?.[0]?.text || ""), JSON.stringify(balancedSideEffectRun));
} finally {
  await client?.close().catch(() => {});
  await stopChild(lca?.child);
  await new Promise((resolve) => mock.server.close(resolve));
  await rm(base, { recursive: true, force: true });
}

console.log(`\nBruno bridge tests: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
