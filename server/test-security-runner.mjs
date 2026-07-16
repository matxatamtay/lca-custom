// Local Coding Agent isolated security regression runner
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const workspace = await mkdtemp(path.join(os.tmpdir(), "lca-security-"));
const port = await findFreePort();
const endpoint = `http://127.0.0.1:${port}/mcp`;
let output = "";

const server = spawn(process.execPath, ["server.mjs"], {
  cwd: APP_DIR,
  env: {
    ...process.env,
    PORT: String(port),
    AGENT_HOST: "127.0.0.1",
    AGENT_MODE: "safe",
    AGENT_POLICY: "balanced",
    AGENT_WORKSPACE: workspace,
    AGENT_EXTRA_ROOTS: "",
    AGENT_AUDIT: "0",
    AGENT_HTTP_LOG: "0",
    MCP_AUTH_TOKEN: ""
  },
  stdio: ["ignore", "pipe", "pipe"]
});
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

let exitCode = 1;
try {
  await waitForHealth(port, server);
  exitCode = await runTest(endpoint);
} finally {
  await stopProcess(server);
  await rm(workspace, { recursive: true, force: true });
}
process.exit(exitCode);

function findFreePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.unref();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      const selected = typeof address === "object" && address ? address.port : 0;
      socket.close((error) => error ? reject(error) : resolve(selected));
    });
  });
}

async function waitForHealth(selectedPort, processHandle) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Security test server exited early (${processHandle.exitCode}).
${output}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${selectedPort}/healthz`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for isolated security test server.
${output}`);
}

function runTest(testEndpoint) {
  return new Promise((resolve, reject) => {
    const test = spawn(process.execPath, ["test-security.mjs"], {
      cwd: APP_DIR,
      env: { ...process.env, TEST_ENDPOINT: testEndpoint },
      stdio: "inherit"
    });
    test.once("error", reject);
    test.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Security test terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function stopProcess(processHandle) {
  if (processHandle.exitCode !== null) return;
  processHandle.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => processHandle.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
  if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
}
