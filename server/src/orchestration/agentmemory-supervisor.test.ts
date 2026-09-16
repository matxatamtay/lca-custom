import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AgentMemoryCliController,
  AgentMemorySupervisor,
  HttpAgentMemoryHealthProbe,
  SupervisedMemoryPort
} from "./agentmemory-supervisor.js";

const TEST_ENGINE_PORT = 65_321;

test("readiness probe waits for a post-registration AgentMemory endpoint", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const probe = new HttpAgentMemoryHealthProbe({
    baseUrl: "http://127.0.0.1:3111/",
    secret: "test-secret",
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("Authorization")
      });
      return new Response("{}", { status: 200 });
    }
  });

  assert.equal(await probe.isReady(), true);
  assert.deepEqual(requests, [{
    url: "http://127.0.0.1:3111/agentmemory/diagnostics/followup",
    authorization: "Bearer test-secret"
  }]);
});

test("readiness probe rejects an unregistered endpoint", async () => {
  const probe = new HttpAgentMemoryHealthProbe({
    fetch: async () => new Response("", { status: 404 })
  });

  assert.equal(await probe.isReady(), false);
});

test("starts AgentMemory once and waits until health is ready", async () => {
  let ready = false;
  let starts = 0;
  let probes = 0;
  const supervisor = new AgentMemorySupervisor({
    probe: {
      async isReady() {
        probes += 1;
        return ready;
      }
    },
    runtime: {
      async start() {
        starts += 1;
        ready = true;
      },
      async close() {}
    },
    attempts: 2,
    retryDelayMs: 0,
    sleep: async () => {}
  });

  await supervisor.ensureReady();

  assert.equal(starts, 1);
  assert.equal(probes, 2);
});

test("deduplicates concurrent automatic starts", async () => {
  let ready = false;
  let starts = 0;
  let releaseStart: (() => void) | undefined;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const supervisor = new AgentMemorySupervisor({
    probe: { async isReady() { return ready; } },
    runtime: {
      async start() {
        starts += 1;
        await startGate;
        ready = true;
      },
      async close() {}
    },
    attempts: 2,
    retryDelayMs: 0,
    sleep: async () => {}
  });

  const first = supervisor.ensureReady();
  const second = supervisor.ensureReady();
  releaseStart?.();
  await Promise.all([first, second]);

  assert.equal(starts, 1);
});

test("fails loudly when AgentMemory never becomes healthy", async () => {
  const supervisor = new AgentMemorySupervisor({
    probe: { async isReady() { return false; } },
    runtime: { async start() {}, async close() {} },
    attempts: 2,
    retryDelayMs: 0,
    sleep: async () => {}
  });

  await assert.rejects(supervisor.ensureReady(), /did not become ready/);
});

test("surfaces a managed runtime startup failure instead of timing out blindly", async () => {
  const supervisor = new AgentMemorySupervisor({
    probe: { async isReady() { return false; } },
    runtime: {
      async start() {},
      async close() {},
      startupFailure() { return new Error("Docker daemon is unavailable"); }
    },
    attempts: 100,
    retryDelayMs: 0,
    sleep: async () => {}
  });

  await assert.rejects(
    supervisor.ensureReady(),
    /AgentMemory failed during automatic startup: Docker daemon is unavailable/
  );
});

test("supervised memory checks readiness before recall", async () => {
  const calls: string[] = [];
  const supervisor = new AgentMemorySupervisor({
    probe: { async isReady() { calls.push("health"); return true; } },
    runtime: { async start() { calls.push("start"); }, async close() {} }
  });
  const memory = new SupervisedMemoryPort(supervisor, {
    async recall() {
      calls.push("recall");
      return [];
    }
  });

  await memory.recall({ task: "recall", root: "/repo" });

  assert.deepEqual(calls, ["health", "recall"]);
});

test("prepares the managed runtime before starting the AgentMemory worker", async () => {
  const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "lca-agentmemory-controller-"));
  const cliPath = path.join(
    runtimeDirectory,
    "node_modules",
    "@agentmemory",
    "agentmemory",
    "dist",
    "cli.mjs"
  );
  try {
    await mkdir(path.dirname(cliPath), { recursive: true });
    await writeFile(cliPath, [
      "const command = process.argv[2];",
      "if (command) process.exit(0);",
      "setInterval(() => {}, 1_000);",
      ""
    ].join("\n"));

    const prepared: string[] = [];
    const controller = new AgentMemoryCliController({
      runtimeDirectory,
      enginePort: TEST_ENGINE_PORT,
      installIfMissing: false,
      useDocker: false,
      prepareRuntime: async (directory) => {
        prepared.push(directory);
      }
    });

    await controller.start();
    assert.deepEqual(prepared, [path.resolve(runtimeDirectory)]);
    await controller.close();
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("does not opt into Docker unless the caller explicitly requests it", async () => {
  const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "lca-agentmemory-native-"));
  const cliPath = path.join(
    runtimeDirectory,
    "node_modules",
    "@agentmemory",
    "agentmemory",
    "dist",
    "cli.mjs"
  );
  const capturePath = path.join(runtimeDirectory, "docker-mode.txt");
  const previousUseDocker = process.env.AGENTMEMORY_USE_DOCKER;
  try {
    delete process.env.AGENTMEMORY_USE_DOCKER;
    await mkdir(path.dirname(cliPath), { recursive: true });
    await writeFile(cliPath, [
      "import { writeFileSync } from 'node:fs';",
      "const command = process.argv[2];",
      "if (command) process.exit(0);",
      "writeFileSync(process.env.LCA_CAPTURE_PATH, process.env.AGENTMEMORY_USE_DOCKER ?? '<unset>');",
      "setInterval(() => {}, 1_000);",
      ""
    ].join("\n"));

    const controller = new AgentMemoryCliController({
      runtimeDirectory,
      enginePort: TEST_ENGINE_PORT,
      installIfMissing: false,
      env: { LCA_CAPTURE_PATH: capturePath }
    });

    await controller.start();
    await waitForFile(capturePath);
    assert.equal(await readFile(capturePath, "utf8"), "<unset>");
    await controller.close();
  } finally {
    if (previousUseDocker === undefined) delete process.env.AGENTMEMORY_USE_DOCKER;
    else process.env.AGENTMEMORY_USE_DOCKER = previousUseDocker;
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("captures child-process diagnostics when AgentMemory exits during startup", async () => {
  const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "lca-agentmemory-failure-"));
  const cliPath = path.join(
    runtimeDirectory,
    "node_modules",
    "@agentmemory",
    "agentmemory",
    "dist",
    "cli.mjs"
  );
  try {
    await mkdir(path.dirname(cliPath), { recursive: true });
    await writeFile(cliPath, [
      "const command = process.argv[2];",
      "if (command) process.exit(0);",
      "console.error('cannot connect to Docker daemon');",
      "process.exit(23);",
      ""
    ].join("\n"));

    const controller = new AgentMemoryCliController({
      runtimeDirectory,
      enginePort: TEST_ENGINE_PORT,
      installIfMissing: false
    });

    await controller.start();
    await waitFor(() => controller.startupFailure() !== undefined);
    assert.match(controller.startupFailure()?.message ?? "", /exited with code 23/);
    assert.match(controller.startupFailure()?.message ?? "", /cannot connect to Docker daemon/);
    await controller.close();
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

async function waitForFile(filePath: string): Promise<void> {
  await waitFor(async () => {
    try {
      await readFile(filePath, "utf8");
      return true;
    } catch {
      return false;
    }
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for test condition.");
}
