// Local Coding Agent DBeaver Desktop MCP bridge tests
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
  callDBeaverDesktopTool,
  callReadOnlyDBeaverDesktopTool,
  dbeaverDesktopStatus,
  listDBeaverDesktopTools,
  normalizeDBeaverDesktopEndpoint
} from "./dbeaver-desktop.mjs";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(SERVER_DIR, "server.mjs");
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function createMockDBeaver(calls) {
  const mcp = new McpServer({ name: "Mock DBeaver Desktop", version: "1.0.0" });
  mcp.registerTool(
    "dbeaver_status",
    { description: "Mock status", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: JSON.stringify({ status: "ok" }) }] })
  );
  mcp.registerTool(
    "dbeaver_list_connections",
    {
      description: "Mock connections",
      inputSchema: { project: z.string().optional(), connected_only: z.boolean().optional() }
    },
    async (args) => {
      calls.push({ tool: "dbeaver_list_connections", args });
      return { content: [{ type: "text", text: JSON.stringify({ count: 1, connections: [{ id: "demo", name: "Demo", project: "General", connected: true }] }) }] };
    }
  );
  mcp.registerTool(
    "dbeaver_database_summary",
    {
      description: "Mock database summary",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { connection: z.string() }
    },
    async (args) => {
      calls.push({ tool: "dbeaver_database_summary", args });
      return { content: [{ type: "text", text: JSON.stringify({ product: "SQLite", args }) }] };
    }
  );
  mcp.registerTool(
    "dbeaver_simulate_change",
    {
      description: "Mock simulation",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        connection: z.string(),
        sql: z.string(),
        allow_simulation: z.boolean(),
        acknowledge_external_side_effects: z.boolean()
      }
    },
    async (args) => {
      calls.push({ tool: "dbeaver_simulate_change", args });
      return { content: [{ type: "text", text: JSON.stringify({ rollback_succeeded: true, committed: false, args }) }] };
    }
  );
  mcp.registerTool(
    "dbeaver_propose_sql",
    {
      description: "Mock SQL proposal",
      inputSchema: { editor_id: z.string().optional(), connection: z.string().optional(), sql: z.string() }
    },
    async (args) => {
      calls.push({ tool: "dbeaver_propose_sql", args });
      return { content: [{ type: "text", text: JSON.stringify({ artifact_type: "sql", editor_id: "editor-1", proposal_id: "proposal-1", sql: args.sql }) }] };
    }
  );
  mcp.registerTool(
    "dbeaver_save_sql_snippet",
    { description: "Mock Save As", inputSchema: { editor_id: z.string() } },
    async (args) => {
      calls.push({ tool: "dbeaver_save_sql_snippet", args });
      return { content: [{ type: "text", text: JSON.stringify({ save_dialog_opened: true, editor_id: args.editor_id }) }] };
    }
  );
  mcp.registerTool(
    "dbeaver_explain_query",
    {
      description: "Mock explain",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { connection: z.string(), project: z.string().optional(), sql: z.string(), analyze: z.boolean().optional() }
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify({ plan: "SCAN demo", args }) }] })
  );
  mcp.registerTool(
    "dbeaver_prepare_sql_execution",
    {
      description: "Mock native confirmation",
      inputSchema: {
        editor_id: z.string().optional(),
        connection: z.string().optional(),
        project: z.string().optional(),
        sql: z.string().optional(),
        max_rows: z.number().optional(),
        timeout_seconds: z.number().optional(),
        auto_connect: z.boolean().optional()
      }
    },
    async (args) => {
      calls.push({ tool: "dbeaver_prepare_sql_execution", args });
      return { content: [{ type: "text", text: JSON.stringify({ approved: true, approval_id: "approved-1", one_time: true, args }) }] };
    }
  );
  mcp.registerTool(
    "dbeaver_execute_sql",
    {
      description: "Mock approved SQL",
      inputSchema: { approval_id: z.string() }
    },
    async (args) => {
      calls.push({ tool: "dbeaver_execute_sql", args });
      return { content: [{ type: "text", text: JSON.stringify({ execution_id: "execution-1", row_count: 1, preview_rows: [{ answer: 42 }], args }) }] };
    }
  );
  mcp.registerTool(
    "dbeaver_get_last_result",
    { description: "Mock last result", annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: {} },
    async () => ({ content: [{ type: "text", text: JSON.stringify({ available: true, execution_id: "execution-1", preview_rows: [{ answer: 42 }] }) }] })
  );
  mcp.registerTool(
    "dbeaver_fetch_result",
    {
      description: "Mock result page",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { execution_id: z.string().optional(), page: z.number().optional(), page_size: z.number().optional() }
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify({ execution_id: "execution-1", page: args.page || 1, rows: [{ answer: 42 }], has_more: false }) }] })
  );
  return mcp;
}

async function startMockDBeaver() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.url !== "/mcp" || req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    const mcp = createMockDBeaver(calls);
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
  for (let index = 0; index < 80; index++) {
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
      DBEAVER_DESKTOP_MCP_URL: endpoint,
      DBEAVER_DESKTOP_TIMEOUT_MS: "10000"
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
  const client = new Client({ name: "dbeaver-bridge-test", version: "1.0.0" });
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

const base = await mkdtemp(path.join(os.tmpdir(), "lca-dbeaver-desktop-"));
const mock = await startMockDBeaver();
let lca;
let client;
try {
  check("default endpoint is loopback", normalizeDBeaverDesktopEndpoint().includes("127.0.0.1:3846"));
  let rejectedRemote = false;
  try {
    normalizeDBeaverDesktopEndpoint("https://example.com/mcp");
  } catch (error) {
    rejectedRemote = /loopback/.test(error.message);
  }
  check("bridge rejects remote endpoints by default", rejectedRemote);

  const status = await dbeaverDesktopStatus({ endpoint: mock.endpoint });
  check("module connects to mock DBeaver MCP", status.connected && status.tools.includes("dbeaver_execute_sql"), JSON.stringify(status));

  const listed = await listDBeaverDesktopTools({ endpoint: mock.endpoint });
  check("module lists upstream schemas", listed.tools.some((tool) => tool.name === "dbeaver_list_connections" && tool.inputSchema), JSON.stringify(listed.tools));

  const preparedDirect = await callDBeaverDesktopTool("dbeaver_prepare_sql_execution", { connection: "demo", sql: "select 42" }, { endpoint: mock.endpoint });
  check("module forwards native confirmation preparation", /approved-1/.test(preparedDirect.content?.[0]?.text || ""), JSON.stringify(preparedDirect));
  const direct = await callDBeaverDesktopTool("dbeaver_execute_sql", { approval_id: "approved-1" }, { endpoint: mock.endpoint });
  check("module forwards approved SQL execution", /42/.test(direct.content?.[0]?.text || ""), JSON.stringify(direct));
  const readOnlyDirect = await callReadOnlyDBeaverDesktopTool("dbeaver_database_summary", { connection: "demo" }, { endpoint: mock.endpoint });
  check("module forwards declared read-only tools", /SQLite/.test(readOnlyDirect.content?.[0]?.text || ""), JSON.stringify(readOnlyDirect));
  let rejectedWriteTool = false;
  try {
    await callReadOnlyDBeaverDesktopTool("dbeaver_execute_sql", { approval_id: "approved-1" }, { endpoint: mock.endpoint });
  } catch (error) {
    rejectedWriteTool = /not declared read-only/.test(error.message);
  }
  check("read-only passthrough rejects write-capable tools", rejectedWriteTool);

  lca = await startLca(path.join(base, "workspace"), mock.endpoint);
  client = await connect(lca.port);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const name of [
    "dbeaver_status",
    "dbeaver_list_tools",
    "dbeaver_call_tool",
    "dbeaver_list_connections",
    "dbeaver_propose_sql",
    "dbeaver_save_sql_snippet",
    "dbeaver_prepare_sql_execution",
    "dbeaver_execute_sql",
    "dbeaver_get_last_result",
    "dbeaver_fetch_result",
    "dbeaver_simulate_change"
  ]) {
    check(`${name} is exposed by LCA`, names.has(name), JSON.stringify([...names]));
  }
  const proposalDescriptor = tools.tools.find((tool) => tool.name === "dbeaver_propose_sql");
  const artifactResourceUri = proposalDescriptor?._meta?.["openai/outputTemplate"] || "";
  check(
    "SQL proposal exposes a fingerprinted artifact widget",
    /^ui:\/\/widget\/dbeaver-sql-artifact-[0-9a-f]{12}\.html$/.test(artifactResourceUri) &&
      proposalDescriptor?._meta?.ui?.resourceUri === artifactResourceUri,
    JSON.stringify(proposalDescriptor)
  );
  const resources = await client.listResources();
  const resourceUris = new Set(resources.resources?.map((resource) => resource.uri));
  check("fingerprinted SQL artifact resource is listed", resourceUris.has(artifactResourceUri), JSON.stringify(resources.resources));
  check("legacy SQL artifact resource remains listed", resourceUris.has("ui://widget/dbeaver-sql-artifact.html"), JSON.stringify(resources.resources));
  let stableResourceReads = true;
  for (let index = 0; index < 20; index++) {
    const widgetResource = await client.readResource({ uri: artifactResourceUri });
    const html = widgetResource.contents?.[0]?.text || "";
    if (widgetResource.contents?.[0]?.mimeType !== "text/html;profile=mcp-app" || !html.includes("SQL ARTIFACT")) {
      stableResourceReads = false;
      break;
    }
  }
  check("SQL artifact template is stable across repeated reads", stableResourceReads);
  const legacyWidgetResource = await client.readResource({ uri: "ui://widget/dbeaver-sql-artifact.html" });
  check("legacy SQL artifact alias serves the cached template", /SQL ARTIFACT/.test(legacyWidgetResource.contents?.[0]?.text || ""));
  const prepareDescriptor = tools.tools.find((tool) => tool.name === "dbeaver_prepare_sql_execution");
  const executeDescriptor = tools.tools.find((tool) => tool.name === "dbeaver_execute_sql");
  check("SQL preparation is app-only", JSON.stringify(prepareDescriptor?._meta?.ui?.visibility) === JSON.stringify(["app"]), JSON.stringify(prepareDescriptor));
  check("SQL execution is app-only", JSON.stringify(executeDescriptor?._meta?.ui?.visibility) === JSON.stringify(["app"]), JSON.stringify(executeDescriptor));

  const connections = await call(client, "dbeaver_list_connections", { connected_only: true });
  check("LCA forwards connection listing", /Demo/.test(connections.content?.[0]?.text || ""), JSON.stringify(connections));
  const summary = await call(client, "dbeaver_call_tool", { tool: "dbeaver_database_summary", arguments: { connection: "demo" } });
  check("LCA forwards generic read-only DBeaver tools", /SQLite/.test(summary.content?.[0]?.text || ""), JSON.stringify(summary));

  const proposal = await call(client, "dbeaver_propose_sql", { connection: "demo", sql: "select 42" });
  check("LCA forwards visible SQL proposals", /proposal-1/.test(proposal.content?.[0]?.text || ""), JSON.stringify(proposal));
  const runIntentToken = proposal?._meta?.dbeaver_run_intent?.token || "";
  check("SQL proposal returns a widget-only run capability", Boolean(runIntentToken), JSON.stringify(proposal));
  check("run capability is absent from model-visible content", !String(proposal.content?.[0]?.text || "").includes(runIntentToken), JSON.stringify(proposal));
  const saved = await call(client, "dbeaver_save_sql_snippet", { editor_id: "editor-1" });
  check("LCA forwards DBeaver Save As", /save_dialog_opened/.test(saved.content?.[0]?.text || ""), JSON.stringify(saved));
  const explained = await call(client, "dbeaver_call_tool", {
    tool: "dbeaver_explain_query",
    arguments: { connection: "demo", sql: "select 42", analyze: false }
  });
  check("LCA artifact explain path remains read-only", /SCAN demo/.test(explained.content?.[0]?.text || ""), JSON.stringify(explained));
  const blockedPrepare = await callRaw(client, "dbeaver_prepare_sql_execution", { max_rows: 10 });
  check("model-style SQL preparation without widget capability is blocked", blockedPrepare.isError === true && /run_intent_token|SQL Artifact Run button/.test(blockedPrepare.content?.[0]?.text || ""), JSON.stringify(blockedPrepare));
  const prepared = await call(client, "dbeaver_prepare_sql_execution", { run_intent_token: runIntentToken, max_rows: 10 });
  check("SQL Artifact Run forwards native DBeaver confirmation", /approved-1/.test(prepared.content?.[0]?.text || ""), JSON.stringify(prepared));
  const blockedExecute = await callRaw(client, "dbeaver_execute_sql", { approval_id: "approved-1" });
  check("model-style SQL execution without widget capability is blocked", blockedExecute.isError === true && /run_intent_token|SQL Artifact Run button/.test(blockedExecute.content?.[0]?.text || ""), JSON.stringify(blockedExecute));
  const query = await call(client, "dbeaver_execute_sql", { approval_id: "approved-1", run_intent_token: runIntentToken });
  check("SQL Artifact Run forwards one-time approved SQL", /42/.test(query.content?.[0]?.text || ""), JSON.stringify(query));
  check(
    "mock received the exact proposed SQL and connection without editor selection",
    mock.calls.some((entry) =>
      entry.tool === "dbeaver_prepare_sql_execution" &&
      entry.args.connection === "demo" &&
      entry.args.sql === "select 42" &&
      entry.args.max_rows === 10 &&
      !Object.hasOwn(entry.args, "editor_id") &&
      !Object.hasOwn(entry.args, "run_intent_token")
    ),
    JSON.stringify(mock.calls)
  );
  check("mock received only native approval token for execution", mock.calls.some((entry) => entry.tool === "dbeaver_execute_sql" && entry.args.approval_id === "approved-1" && Object.keys(entry.args).length === 1), JSON.stringify(mock.calls));
  const lastResult = await call(client, "dbeaver_get_last_result");
  check("LCA returns bounded result previews", /preview_rows/.test(lastResult.content?.[0]?.text || ""), JSON.stringify(lastResult));
  const resultPage = await call(client, "dbeaver_fetch_result", { execution_id: "execution-1", page: 1, page_size: 100 });
  check("LCA forwards paged result reads", /has_more/.test(resultPage.content?.[0]?.text || ""), JSON.stringify(resultPage));
  const simulation = await call(client, "dbeaver_simulate_change", {
    connection: "demo",
    sql: "update t set x=1",
    allow_simulation: true,
    acknowledge_external_side_effects: true
  });
  check("LCA forwards transactional simulation", /rollback_succeeded/.test(simulation.content?.[0]?.text || ""), JSON.stringify(simulation));

  await client.close();
  client = null;
  await stopChild(lca.child);
  lca = null;

  lca = await startLca(path.join(base, "strict-workspace"), mock.endpoint, "strict");
  client = await connect(lca.port);
  const strictRead = await call(client, "dbeaver_call_tool", { tool: "dbeaver_database_summary", arguments: { connection: "demo" } });
  check("strict policy keeps read-only DBeaver discovery available", /SQLite/.test(strictRead.content?.[0]?.text || ""), JSON.stringify(strictRead));
  const strictPrepare = await callRaw(client, "dbeaver_prepare_sql_execution", { connection: "demo", sql: "select 42", run_intent_token: "strict-test-token" });
  check("strict policy blocks operator execution preparation", strictPrepare.isError === true && /policy=strict/.test(strictPrepare.content?.[0]?.text || ""), JSON.stringify(strictPrepare));
  const strictExecute = await callRaw(client, "dbeaver_execute_sql", { approval_id: "approved-1", run_intent_token: "strict-test-token" });
  check("strict policy blocks approved SQL execution", strictExecute.isError === true && /policy=strict/.test(strictExecute.content?.[0]?.text || ""), JSON.stringify(strictExecute));
  const strictSimulation = await callRaw(client, "dbeaver_simulate_change", {
    connection: "demo",
    sql: "update t set x=1",
    allow_simulation: true,
    acknowledge_external_side_effects: true
  });
  check("strict policy blocks change simulation", strictSimulation.isError === true && /policy=strict/.test(strictSimulation.content?.[0]?.text || ""), JSON.stringify(strictSimulation));
} finally {
  await client?.close().catch(() => {});
  await stopChild(lca?.child);
  await new Promise((resolve) => mock.server.close(resolve));
  await rm(base, { recursive: true, force: true });
}

console.log(`\nDBeaver bridge tests: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
