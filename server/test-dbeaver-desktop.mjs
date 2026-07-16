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
    "dbeaver_execute_sql",
    {
      description: "Mock SQL",
      inputSchema: {
        connection: z.string(),
        project: z.string().optional(),
        sql: z.string(),
        max_rows: z.number().optional(),
        timeout_seconds: z.number().optional(),
        auto_connect: z.boolean().optional(),
        allow_write: z.boolean().optional()
      }
    },
    async (args) => {
      calls.push({ tool: "dbeaver_execute_sql", args });
      return { content: [{ type: "text", text: JSON.stringify({ row_count: 1, rows: [{ answer: 42 }], args }) }] };
    }
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

  const direct = await callDBeaverDesktopTool("dbeaver_execute_sql", { connection: "demo", sql: "select 42" }, { endpoint: mock.endpoint });
  check("module forwards SQL tool calls", /42/.test(direct.content?.[0]?.text || ""), JSON.stringify(direct));
  const readOnlyDirect = await callReadOnlyDBeaverDesktopTool("dbeaver_database_summary", { connection: "demo" }, { endpoint: mock.endpoint });
  check("module forwards declared read-only tools", /SQLite/.test(readOnlyDirect.content?.[0]?.text || ""), JSON.stringify(readOnlyDirect));
  let rejectedWriteTool = false;
  try {
    await callReadOnlyDBeaverDesktopTool("dbeaver_execute_sql", { connection: "demo", sql: "select 42" }, { endpoint: mock.endpoint });
  } catch (error) {
    rejectedWriteTool = /not declared read-only/.test(error.message);
  }
  check("read-only passthrough rejects write-capable tools", rejectedWriteTool);

  lca = await startLca(path.join(base, "workspace"), mock.endpoint);
  client = await connect(lca.port);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const name of ["dbeaver_status", "dbeaver_list_tools", "dbeaver_call_tool", "dbeaver_list_connections", "dbeaver_execute_sql", "dbeaver_simulate_change"]) {
    check(`${name} is exposed by LCA`, names.has(name), JSON.stringify([...names]));
  }

  const connections = await call(client, "dbeaver_list_connections", { connected_only: true });
  check("LCA forwards connection listing", /Demo/.test(connections.content?.[0]?.text || ""), JSON.stringify(connections));
  const summary = await call(client, "dbeaver_call_tool", { tool: "dbeaver_database_summary", arguments: { connection: "demo" } });
  check("LCA forwards generic read-only DBeaver tools", /SQLite/.test(summary.content?.[0]?.text || ""), JSON.stringify(summary));

  const query = await call(client, "dbeaver_execute_sql", { connection: "demo", sql: "select 42", max_rows: 10 });
  check("LCA forwards read SQL", /42/.test(query.content?.[0]?.text || ""), JSON.stringify(query));
  check("mock received SQL arguments", mock.calls.some((entry) => entry.tool === "dbeaver_execute_sql" && entry.args.max_rows === 10), JSON.stringify(mock.calls));
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
  const strictRead = await call(client, "dbeaver_execute_sql", { connection: "demo", sql: "select 42" });
  check("strict policy allows read SQL", /42/.test(strictRead.content?.[0]?.text || ""), JSON.stringify(strictRead));
  const strictWrite = await callRaw(client, "dbeaver_execute_sql", { connection: "demo", sql: "delete from t", allow_write: true });
  check("strict policy blocks write SQL", strictWrite.isError === true && /policy=strict/.test(strictWrite.content?.[0]?.text || ""), JSON.stringify(strictWrite));
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
