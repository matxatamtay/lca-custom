// Local Coding Agent Figma Remote MCP bridge tests
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
import { callCompactTool } from "./compact-test-client.mjs";
import {
  callFigmaRemoteTool,
  closeFigmaRemoteClients,
  figmaRemoteStatus,
  figmaRemoteToolAccess,
  friendlyFigmaRemoteError,
  listFigmaRemoteTools,
  normalizeFigmaRemoteEndpoint
} from "./figma-remote.mjs";

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function startLca(workspace, endpoint, tokenPath) {
  await mkdir(workspace, { recursive: true });
  const port = await getFreePort();
  const stderrRef = { value: "" };
  const child = spawn(process.execPath, [SERVER], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_WORKSPACE: workspace,
      AGENT_EXTRA_ROOTS_JSON: "[]",
      AGENTMEMORY_RECORD_SESSIONS: "0",
      AGENT_AUDIT: "0",
      MCP_AUTH_TOKEN: "",
      FIGMA_REMOTE_ENABLED: "1",
      FIGMA_REMOTE_MCP_URL: endpoint,
      FIGMA_REMOTE_AUTH_TOKEN: "test-figma-token",
      FIGMA_REMOTE_ALLOW_INSECURE: "1",
      FIGMA_REMOTE_ALLOW_WRITE: "1",
      FIGMA_REMOTE_TIMEOUT_MS: "10000",
      FIGMA_REMOTE_CALLBACK_URL: `http://127.0.0.1:${port}/integrations/figma/oauth/callback`,
      FIGMA_REMOTE_TOKEN_PATH: tokenPath,
      FIGMA_DESKTOP_MCP_URL: "http://127.0.0.1:1/mcp",
      FIGMA_DESKTOP_TIMEOUT_MS: "1000"
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

async function connectLca(port) {
  const client = new Client({ name: "figma-remote-integration-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

async function callLca(client, action, args = {}) {
  const result = await callCompactTool(client, action, args);
  if (result.isError) throw new Error(result.content?.[0]?.text || `${action} failed`);
  return result;
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

async function startMockRemote() {
  const calls = [];
  let authorizedRequests = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url !== "/mcp" || req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    if (req.headers.authorization !== "Bearer test-figma-token") {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    authorizedRequests++;
    const body = await readJsonBody(req);
    const mcp = new McpServer({ name: "Mock Figma Remote", version: "1.0.0" });
    mcp.registerTool(
      "get_design_context",
      {
        title: "Get design context",
        description: "Read mock design context",
        annotations: { readOnlyHint: true },
        inputSchema: { fileKey: z.string().optional(), nodeId: z.string().optional() }
      },
      async (args) => {
        calls.push({ tool: "get_design_context", args });
        return { content: [{ type: "text", text: JSON.stringify(args) }] };
      }
    );
    mcp.registerTool(
      "use_figma",
      {
        title: "Use Figma",
        description: "Write mock canvas content",
        annotations: { readOnlyHint: false },
        inputSchema: { instruction: z.string() }
      },
      async (args) => {
        calls.push({ tool: "use_figma", args });
        return { content: [{ type: "text", text: "canvas updated" }] };
      }
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => undefined);
      mcp.close().catch(() => undefined);
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  const port = await getFreePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    server,
    calls,
    endpoint: `http://127.0.0.1:${port}/mcp`,
    get authorizedRequests() {
      return authorizedRequests;
    }
  };
}

const base = await mkdtemp(path.join(os.tmpdir(), "lca-figma-remote-"));
const mock = await startMockRemote();
const common = {
  endpoint: mock.endpoint,
  authToken: "test-figma-token",
  allowInsecure: true,
  allowWrite: false,
  callbackUrl: "http://127.0.0.1:8790/integrations/figma/oauth/callback",
  tokenPath: path.join(base, "oauth.json"),
  timeoutMs: 10_000
};
let lca;
let lcaClient;

try {
  let rejectedInsecure = false;
  try {
    normalizeFigmaRemoteEndpoint(mock.endpoint);
  } catch (error) {
    rejectedInsecure = /HTTPS/.test(error.message);
  }
  check("remote endpoint requires HTTPS by default", rejectedInsecure);

  const status = await figmaRemoteStatus(common);
  check("remote status connects with bearer authentication", status.connected && status.auth_mode === "bearer", JSON.stringify(status));
  check("remote status classifies read and write tools", status.tools.some((tool) => tool.name === "get_design_context" && tool.read_only) && status.tools.some((tool) => tool.name === "use_figma" && !tool.read_only), JSON.stringify(status.tools));

  const listed = await listFigmaRemoteTools(common);
  check("remote tools/list exposes live schemas", listed.tools.some((tool) => tool.name === "use_figma" && tool.inputSchema), JSON.stringify(listed.tools));

  const read = await callFigmaRemoteTool("get_design_context", { fileKey: "FILE", nodeId: "1:2" }, common);
  check("remote bridge forwards read tools", /FILE/.test(read.content?.[0]?.text || ""), JSON.stringify(read));

  let writeBlocked = false;
  try {
    await callFigmaRemoteTool("use_figma", { instruction: "Create a card" }, common);
  } catch (error) {
    writeBlocked = /FIGMA_REMOTE_ALLOW_WRITE=1/.test(error.message);
  }
  check("remote bridge blocks canvas writes by default", writeBlocked);

  const write = await callFigmaRemoteTool(
    "use_figma",
    { instruction: "Create a card" },
    { ...common, allowWrite: true }
  );
  check("remote bridge forwards canvas writes when explicitly enabled", write.content?.[0]?.text === "canvas updated", JSON.stringify(write));
  check("mock received the write call", mock.calls.some((entry) => entry.tool === "use_figma"));
  check("bearer header is attached to upstream requests", mock.authorizedRequests > 0, `authorized_requests=${mock.authorizedRequests}`);

  check("known use_figma tool is classified as write-capable", figmaRemoteToolAccess({ name: "use_figma" }).readOnly === false);
  check("unknown upstream tools fail closed", figmaRemoteToolAccess({ name: "future_tool" }).readOnly === false);
  const catalogError = friendlyFigmaRemoteError(
    Object.assign(new Error("HTTP 403: Invalid OAuth error response: Forbidden"), { stack: "at registerClient (auth.js:914)" })
  );
  check("catalog registration failures have a clear error", /MCP Catalog/.test(catalogError.message), catalogError.message);

  lca = await startLca(path.join(base, "workspace"), mock.endpoint, path.join(base, "lca-oauth.json"));
  lcaClient = await connectLca(lca.port);
  const modelTools = await lcaClient.listTools();
  check("remote integration stays behind the single figma facade", modelTools.tools.some((tool) => tool.name === "figma") && !modelTools.tools.some((tool) => tool.name === "figma_remote_call_tool"));

  const combinedStatusResult = await callLca(lcaClient, "figma_status");
  const combinedStatus = JSON.parse(combinedStatusResult.content?.[0]?.text || "{}");
  check("LCA prefers connected Figma Remote over Desktop fallback", combinedStatus.source === "remote" && combinedStatus.remote?.connected === true, JSON.stringify(combinedStatus));

  const facadeWrite = await callLca(lcaClient, "figma_remote_call_tool", {
    tool: "use_figma",
    arguments: { instruction: "Create a settings card" }
  });
  check("compact facade reaches remote canvas write tools", facadeWrite.content?.[0]?.text === "canvas updated", JSON.stringify(facadeWrite));
} finally {
  if (lcaClient) await lcaClient.close().catch(() => undefined);
  await stopChild(lca?.child);
  await closeFigmaRemoteClients();
  await new Promise((resolve) => mock.server.close(resolve));
  await rm(base, { recursive: true, force: true });
}

console.log(`\n==== FIGMA REMOTE RESULT: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
