// Compact MCP surface regression tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { TARGET_TOOL_CATALOG } from "./dist/interfaces/mcp/tool-catalog.js";

const SERVER = path.resolve("server.mjs");
const FACADE_NAMES = [
  "workspace_search",
  "workspace_read",
  "workspace_edit",
  "workspace_exec",
  "workspace_process",
  "workspace_git",
  "workspace_verify",
  "workspace_status",
  "workspace_skill",
  "figma",
  "dbeaver",
  "bruno"
];
const DIRECT_NAMES = new Set(["workspace_context", "lca_input"]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function startServer(workspace) {
  const port = await getFreePort();
  const stderrRef = { value: "" };
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_WORKSPACE: workspace,
      AGENTMEMORY_RECORD_SESSIONS: "0",
      MCP_AUTH_TOKEN: "",
      AGENT_AUDIT: "0"
    },
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.on("data", (chunk) => (stderrRef.value += chunk));

  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return { child, port };
    } catch {}
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}\n${stderrRef.value}`);
    await wait(100);
  }
  throw new Error(`Server did not become ready on port ${port}\n${stderrRef.value}`);
}

async function stopServer(server) {
  if (!server?.child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(server.child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    server.child.kill("SIGTERM");
  }
  await wait(300);
}

async function connect(port) {
  const client = new Client({ name: "compact-surface-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

function firstText(result) {
  return result?.content?.find((item) => item.type === "text")?.text || "";
}

function parseJsonResult(result) {
  return JSON.parse(firstText(result));
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "lca-compact-surface-"));
let server;
let client;

try {
  server = await startServer(workspace);
  client = await connect(server.port);

  const compactTools = (await client.listTools()).tools || [];
  const compactNames = compactTools.map((tool) => tool.name);
  const targetNames = TARGET_TOOL_CATALOG.map((tool) => tool.name);

  assert.deepEqual(compactNames, targetNames, "active compact surface must match the target catalog exactly");
  assert.ok(compactTools.length <= 16, `expected at most 16 tools, received ${compactTools.length}`);

  const schemaBytes = Buffer.byteLength(JSON.stringify(compactTools), "utf8");
  assert.ok(schemaBytes <= 20_000, `compact tool schema is too large: ${schemaBytes} bytes`);

  const assigned = new Map();
  for (const facade of FACADE_NAMES) {
    const discovered = await client.callTool({ name: facade, arguments: { action: "discover" } });
    assert.equal(discovered.isError, undefined, `${facade} discovery failed: ${firstText(discovered)}`);
    for (const action of discovered.structuredContent?.actions || []) {
      const groups = assigned.get(action.name) || [];
      groups.push(facade);
      assigned.set(action.name, groups);
    }
  }

  const duplicated = [...assigned.entries()].filter(([, groups]) => groups.length !== 1);
  assert.deepEqual(duplicated, [], `hidden tools assigned to multiple facades: ${JSON.stringify(duplicated)}`);
  assert.equal(assigned.size, 148, `expected complete internal backend coverage, received ${assigned.size} actions`);
  for (const directName of DIRECT_NAMES) assert.ok(compactNames.includes(directName), `${directName} must remain direct`);

  const writeResult = await client.callTool({
    name: "workspace_edit",
    arguments: { action: "write", arguments: { path: "compact.txt", content: "compact facade works\n" } }
  });
  assert.notEqual(writeResult.isError, true, firstText(writeResult));

  const readResult = await client.callTool({
    name: "workspace_read",
    arguments: { action: "one", arguments: { path: "compact.txt" } }
  });
  assert.equal(parseJsonResult(readResult).content, "compact facade works\n");

  const memoryStatus = parseJsonResult(await client.callTool({
    name: "workspace_read",
    arguments: { action: "memory" }
  }));
  assert.equal(memoryStatus.obsidian_compatible, true, "persistent memory must be reachable through workspace_read");

  const blocked = await client.callTool({
    name: "workspace_read",
    arguments: { action: "run_command", arguments: { command: "echo should-not-run" } }
  });
  assert.equal(blocked.isError, true, "cross-group backend dispatch must be rejected");
  assert.match(firstText(blocked), /Unknown workspace_read action/);

  const status = parseJsonResult(await client.callTool({ name: "workspace_status", arguments: {} }));
  assert.equal(status.tool_surface, "compact");

  const lcaInput = compactTools.find((tool) => tool.name === "lca_input");
  assert.equal(lcaInput?._meta?.["openai/outputTemplate"], "ui://widget/lca-compact-input-v2.html");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    model_facing_tools: compactTools.length,
    internal_backend_actions: assigned.size,
    compact_schema_bytes: schemaBytes,
    hidden_actions_covered: assigned.size
  }, null, 2)}\n`);
} finally {
  try { await client?.close(); } catch {}
  await stopServer(server);
  await rm(workspace, { recursive: true, force: true });
}
