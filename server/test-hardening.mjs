// Operational hardening and trusted-runtime regression suite.
// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { callCompactTool } from "./compact-test-client.mjs";

const SERVER = path.resolve("server.mjs");
let pass = 0;
let fail = 0;
function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    console.error(`[FAIL] ${name}${detail ? `\n${detail}` : ""}`);
  }
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function startServer(workspace, { auth = "", maxBody = "1048576", audit = "0" } = {}) {
  await mkdir(workspace, { recursive: true });
  const port = await freePort();
  let stderr = "";
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_WORKSPACE: workspace,
      AGENTMEMORY_RECORD_SESSIONS: "0",
      AGENT_EXTRA_ROOTS_JSON: "[]",
      MCP_AUTH_TOKEN: auth,
      AGENT_MAX_BODY_BYTES: maxBody,
      AGENT_AUDIT: audit
    },
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return { child, port };
    } catch {}
    if (child.exitCode !== null) throw new Error(`Server exited early: ${stderr}`);
    await wait(100);
  }
  throw new Error(`Server did not become ready: ${stderr}`);
}

async function stopServer(server) {
  if (!server?.child?.pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(server.child.pid), "/T", "/F"], { windowsHide: true });
  else server.child.kill("SIGTERM");
  await wait(400);
}

async function connect(port, token = "") {
  const client = new Client({ name: "hardening-test", version: "1.0.0" });
  const options = token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined;
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), options));
  return client;
}

async function call(client, name, args = {}) {
  const result = await callCompactTool(client, name, args);
  return { result, isError: Boolean(result.isError), text: result.content?.[0]?.text || "" };
}

function chunkedPost(port, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: { "content-type": "application/json", "transfer-encoding": "chunked" }
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.write(body.slice(0, Math.floor(body.length / 2)));
    request.end(body.slice(Math.floor(body.length / 2)));
  });
}

const base = await mkdtemp(path.join(os.tmpdir(), "lca-hardening-"));
let server;
let client;
try {
  server = await startServer(path.join(base, "trusted"), { maxBody: "8192", audit: "1" });
  client = await connect(server.port);

  const health = await (await fetch(`http://127.0.0.1:${server.port}/healthz`)).json();
  check("health reports trusted compact runtime", health.runtime === "trusted-local" && health.tool_surface === "compact", JSON.stringify(health));
  check("removed mode and policy fields stay absent", health.mode === undefined && health.policy === undefined && health.allow_dangerous === undefined, JSON.stringify(health));

  const hostileOrigin = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" }
  });
  check("browser Origin is denied by default", hostileOrigin.status === 403, `status=${hostileOrigin.status}`);
  check("chunked request bodies remain size-limited", (await chunkedPost(server.port, JSON.stringify({ data: "x".repeat(12000) }))) === 413);

  for (const route of ["/metrics", "/ui", "/companion"]) {
    const response = await fetch(`http://127.0.0.1:${server.port}${route}`);
    check(`${route} legacy HTTP route is absent`, response.status === 404, `status=${response.status}`);
  }

  const write = await call(client, "write_file", { path: "direct.txt", content: "direct\n" });
  check("writes execute without approval", !write.isError, write.text);
  const command = await call(client, "run_command", { command: "node --version" });
  check("commands execute without policy round-trip", !command.isError && /v\d+/.test(command.text), command.text);
  const deletion = await call(client, "delete_path", { path: "direct.txt" });
  check("deletes execute without approval", !deletion.isError, deletion.text);

  const outsideFile = path.join(base, "outside-project.txt");
  const absoluteWrite = await call(client, "write_file", { path: outsideFile, content: "outside\n" });
  const absoluteRead = await call(client, "read_file", { path: outsideFile });
  check("absolute paths outside configured projects execute directly", !absoluteWrite.isError && JSON.parse(absoluteRead.text).content === "outside\n", absoluteRead.text);

  await client.close();
  client = null;
  await stopServer(server);
  server = null;

  const authToken = `operator-${Date.now()}`;
  server = await startServer(path.join(base, "auth"), { auth: authToken });
  const queryAuth = await fetch(`http://127.0.0.1:${server.port}/mcp?token=${encodeURIComponent(authToken)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  check("query-string bearer tokens are rejected", queryAuth.status === 401, `status=${queryAuth.status}`);
  client = await connect(server.port, authToken);
  check("header bearer authentication works", !(await call(client, "workspace_info")).isError);
  await client.close();
  client = null;
  await stopServer(server);
  server = null;

  const workspaceA = path.join(base, "workspace-a");
  server = await startServer(workspaceA);
  client = await connect(server.port);
  await call(client, "apply_patch", { operations: [{ op: "create", path: "created.txt", content: "created" }] });
  await call(client, "undo_last_patch");
  check("undo removes files created by apply_patch", (await call(client, "stat_path", { path: "created.txt" })).isError);
  await call(client, "make_dir", { path: "source-dir" });
  await call(client, "write_file", { path: "source-dir/a.txt", content: "a" });
  await call(client, "move_path", { from: "source-dir", to: "dest-dir" });
  await call(client, "undo_last_patch");
  check("undo restores renamed directory source", !(await call(client, "stat_path", { path: "source-dir/a.txt" })).isError);
  check("undo removes renamed directory destination", (await call(client, "stat_path", { path: "dest-dir" })).isError);
  await client.close();
  client = null;
  await stopServer(server);
  server = null;

  server = await startServer(path.join(base, "workspace-b"));
  client = await connect(server.port);
  check("patch history remains scoped by workspace", (await call(client, "undo_last_patch")).isError);

  const audit = await readFile(path.resolve("data", "audit.log"), "utf8").catch(() => "");
  check("audit remains available", audit.length > 0);
} finally {
  await client?.close().catch(() => {});
  await stopServer(server);
  await rm(base, { recursive: true, force: true });
}

console.log(`\n==== HARDENING: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
