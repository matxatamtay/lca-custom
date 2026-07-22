// Cross-platform isolated runner for the complete compact facade smoke test.
// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(APP_DIR, "server.mjs");
const TEST_PATH = path.join(APP_DIR, "test-agent.mjs");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function stop(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await new Promise((resolve) => killer.once("exit", resolve));
  } else {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), wait(1500)]);
  }
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "lca-agent-runner-"));
const port = await freePort();
let stderr = "";
const server = spawn(process.execPath, [SERVER_PATH], {
  cwd: APP_DIR,
  env: {
    ...process.env,
    PORT: String(port),
    AGENT_WORKSPACE: workspace,
    AGENT_EXTRA_ROOTS_JSON: "[]",
    AGENTMEMORY_RECORD_SESSIONS: "0",
    AGENT_AUDIT: "0",
    MCP_AUTH_TOKEN: ""
  },
  windowsHide: true,
  stdio: ["ignore", "ignore", "pipe"]
});
server.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) { ready = true; break; }
    } catch {}
    if (server.exitCode !== null) break;
    await wait(100);
  }
  if (!ready) throw new Error(`isolated LCA server did not become ready: ${stderr}`);

  const test = spawn(process.execPath, [TEST_PATH], {
    cwd: APP_DIR,
    env: { ...process.env, TEST_ENDPOINT: `http://127.0.0.1:${port}/mcp` },
    windowsHide: true,
    stdio: "inherit"
  });
  const code = await new Promise((resolve) => test.once("exit", (value) => resolve(value ?? 1)));
  if (code !== 0) process.exitCode = code;
} finally {
  await stop(server);
  await rm(workspace, { recursive: true, force: true });
}
