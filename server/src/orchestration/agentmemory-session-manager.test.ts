import test from "node:test";
import assert from "node:assert/strict";

import {
  AgentMemorySessionManager,
  SessionAwareMemoryPort,
  type AgentMemorySessionClient
} from "./agentmemory-session-manager.js";
import type {
  AgentMemoryObservationInput,
  AgentMemoryRememberInput,
  AgentMemorySessionRecord,
  AgentMemorySessionStartInput
} from "../adapters/agentmemory/agentmemory-http-adapter.js";
import type { AgentMemorySupervisor } from "./agentmemory-supervisor.js";

function fakeSupervisor(events: string[] = []): AgentMemorySupervisor {
  return {
    async ensureReady() { events.push("ready"); }
  } as unknown as AgentMemorySupervisor;
}

function fakeClient(events: string[] = []): AgentMemorySessionClient & {
  starts: AgentMemorySessionStartInput[];
  observations: AgentMemoryObservationInput[];
  memories: AgentMemoryRememberInput[];
  ends: string[];
  sessions: AgentMemorySessionRecord[];
} {
  const starts: AgentMemorySessionStartInput[] = [];
  const observations: AgentMemoryObservationInput[] = [];
  const memories: AgentMemoryRememberInput[] = [];
  const ends: string[] = [];
  const sessions: AgentMemorySessionRecord[] = [];
  return {
    starts,
    observations,
    memories,
    ends,
    sessions,
    projectForRoot() { return "project-one"; },
    async listSessions() { return sessions; },
    async startSession(input) { events.push("start"); starts.push(input); },
    async observe(input) { events.push("observe"); observations.push(input); },
    async remember(input) { events.push("remember"); memories.push(input); },
    async endSession(sessionId) { events.push("end"); ends.push(sessionId); }
  };
}

test("deduplicates concurrent session starts per project root", async () => {
  const events: string[] = [];
  const client = fakeClient(events);
  let releaseStart: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releaseStart = resolve; });
  client.startSession = async (input) => {
    events.push("start");
    client.starts.push(input);
    await gate;
  };
  const sessions = new AgentMemorySessionManager({
    supervisor: fakeSupervisor(events),
    client,
    createId: () => "fixed"
  });

  const first = sessions.ensureSession("/repo", "First task");
  const second = sessions.ensureSession("/repo", "Second task");
  releaseStart?.();
  const [left, right] = await Promise.all([first, second]);

  assert.equal(client.starts.length, 1);
  assert.equal(left.sessionId, right.sessionId);
  assert.equal(sessions.currentSessionId("/repo"), `lca-${process.pid}-fixed`);
});

test("rechecks runtime readiness when reusing an existing session", async () => {
  const events: string[] = [];
  const client = fakeClient(events);
  const sessions = new AgentMemorySessionManager({
    supervisor: fakeSupervisor(events),
    client,
    createId: () => "existing"
  });

  await sessions.ensureSession("/repo", "First task");
  events.length = 0;
  await sessions.ensureSession("/repo", "Second task");

  assert.deepEqual(events, ["ready"]);
  assert.equal(client.starts.length, 1);
});

test("starts a session before delegated memory recall", async () => {
  const events: string[] = [];
  const client = fakeClient(events);
  const sessions = new AgentMemorySessionManager({
    supervisor: fakeSupervisor(events),
    client,
    createId: () => "recall"
  });
  const memory = new SessionAwareMemoryPort(sessions, {
    async recall() {
      events.push("recall");
      return [];
    }
  });

  await memory.recall({ task: "Trace auth flow", root: "/repo" });

  assert.deepEqual(events, ["ready", "start", "recall"]);
  assert.equal(client.starts[0]?.title, "Trace auth flow");
});

test("queues tool observations and persists a concise summary before ending", async () => {
  const events: string[] = [];
  const client = fakeClient(events);
  const sessions = new AgentMemorySessionManager({
    supervisor: fakeSupervisor(events),
    client,
    createId: () => "summary",
    now: () => new Date("2026-07-22T00:00:00.000Z")
  });

  await sessions.recordToolCall({
    tool: "workspace_context",
    root: "/repo",
    task: "Fix retry behavior",
    argsSummary: "task=Fix retry behavior",
    outputSummary: "Context ready",
    success: true,
    durationMs: 12.5,
    files: ["src/retry.ts"],
    evidenceCount: 6
  });
  await sessions.recordToolCall({
    tool: "workspace_edit",
    root: "/repo",
    argsSummary: "action=patch",
    outputSummary: "ok",
    success: false,
    durationMs: 4
  });
  await sessions.close();

  assert.equal(client.starts.length, 1);
  assert.equal(client.observations.length, 2);
  assert.equal(client.memories.length, 1);
  assert.equal(client.ends.length, 1);
  assert.match(String(client.memories[0]?.content), /Fix retry behavior/);
  assert.match(String(client.memories[0]?.content), /workspace_context:1/);
  assert.match(String(client.memories[0]?.content), /workspace_edit:1/);
  assert.match(String(client.memories[0]?.content), /failures: 1/);
  assert.deepEqual(client.memories[0]?.files, ["src/retry.ts"]);
  assert.ok(events.indexOf("remember") < events.indexOf("end"));
});

test("close waits for an already queued observation", async () => {
  const events: string[] = [];
  const client = fakeClient(events);
  let releaseObservation: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releaseObservation = resolve; });
  client.observe = async (input) => {
    events.push("observe-start");
    client.observations.push(input);
    await gate;
    events.push("observe-end");
  };
  const sessions = new AgentMemorySessionManager({
    supervisor: fakeSupervisor(events),
    client,
    createId: () => "queued"
  });

  const observation = sessions.recordToolCall({
    tool: "workspace_read",
    root: "/repo",
    argsSummary: "one file",
    outputSummary: "content",
    success: true,
    durationMs: 2
  });
  const closing = sessions.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.ends.length, 0);
  releaseObservation?.();
  await Promise.all([observation, closing]);

  assert.deepEqual(events.slice(-3), ["observe-end", "remember", "end"]);
});


test("reconciles dead LCA sessions but preserves live processes", async () => {
  const events: string[] = [];
  const client = fakeClient(events);
  client.sessions.push(
    { id: "lca-111-dead", project: "project-one", status: "active", agentId: "lca" },
    { id: "lca-222-live", project: "project-one", status: "active", agentId: "lca" },
    { id: "external-session", project: "project-one", status: "active", agentId: "other" }
  );
  const sessions = new AgentMemorySessionManager({
    supervisor: fakeSupervisor(events),
    client,
    createId: () => "fresh",
    isProcessAlive: (pid) => pid === 222
  });

  await sessions.ensureSession("/repo", "Fresh task");

  assert.deepEqual(client.ends, ["lca-111-dead"]);
  assert.equal(client.starts.length, 1);
});


test("persists an intentional architectural decision immediately", async () => {
  const events: string[] = [];
  const client = fakeClient(events);
  const sessions = new AgentMemorySessionManager({
    supervisor: fakeSupervisor(events),
    client,
    createId: () => "decision",
    now: () => new Date("2026-07-22T00:00:00.000Z")
  });

  await sessions.recordDecision({
    root: "/repo",
    decision: "Expose a compact facade",
    why: "Reduce schema size while preserving compatibility",
    files: ["server/src/interfaces/mcp/compact-mcp-interface.ts"]
  });

  assert.equal(client.memories.length, 1);
  const memory = client.memories[0];
  assert.equal(memory?.type, "fact");
  assert.match(String(memory?.content), /Decision: Expose a compact facade/);
  assert.match(String(memory?.content), /Rationale: Reduce schema size/);
  assert.deepEqual(memory?.concepts?.slice(0, 2), ["architectural-decision", "lca-decision"]);
  assert.deepEqual(memory?.files, ["server/src/interfaces/mcp/compact-mcp-interface.ts"]);
  assert.equal(client.observations.length, 0);

  await sessions.close();
  assert.equal(client.memories.length, 2);
  assert.match(String(client.memories[1]?.content), /decisions: 1/);
});
