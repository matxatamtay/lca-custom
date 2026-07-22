import test from "node:test";
import assert from "node:assert/strict";

import {
  AgentMemorySupervisor,
  SupervisedMemoryPort
} from "./agentmemory-supervisor.js";

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
