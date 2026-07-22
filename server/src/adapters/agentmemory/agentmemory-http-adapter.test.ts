import test from "node:test";
import assert from "node:assert/strict";

import { AgentMemoryHttpAdapter } from "./agentmemory-http-adapter.js";

test("queries AgentMemory smart-search with project scope and maps results", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new AgentMemoryHttpAdapter({
    baseUrl: "http://memory.test",
    secret: "secret",
    projectId: () => "lca-next",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({
        results: [{
          id: "mem-1",
          title: "Do not remove legacy retry",
          content: "Partner X still sends duplicate webhooks.",
          files: ["src/retry.ts"],
          concepts: ["webhook"],
          score: 0.92
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch
  });

  const evidence = await adapter.recall({
    task: "Can LegacyRetryPolicy be removed?",
    root: "/work/lca-custom-next",
    budget: { maxItems: 7 }
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "http://memory.test/agentmemory/smart-search");
  const body = JSON.parse(String(requests[0]?.init?.body));
  assert.deepEqual(body, {
    query: "Can LegacyRetryPolicy be removed?",
    project: "lca-next",
    limit: 7,
    includeLessons: true,
    source: "lca"
  });
  assert.equal(new Headers(requests[0]?.init?.headers).get("authorization"), "Bearer secret");
  assert.equal(evidence[0]?.provider, "agentmemory");
  assert.equal(evidence[0]?.path, "src/retry.ts");
  assert.match(evidence[0]?.content ?? "", /duplicate webhooks/);
});

test("hydrates compact direct-memory hits before returning evidence", async () => {
  const urls: string[] = [];
  const adapter = new AgentMemoryHttpAdapter({
    baseUrl: "http://memory.test",
    fetch: (async (url: string | URL | Request) => {
      const target = String(url);
      urls.push(target);
      if (target.endsWith("/agentmemory/smart-search")) {
        return new Response(JSON.stringify({
          mode: "compact",
          results: [{
            obsId: "mem-compact",
            sessionId: "memory",
            title: "Compact title",
            score: 0.8
          }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        memory: {
          id: "mem-compact",
          title: "Hydrated title",
          content: "Full architectural decision",
          files: ["src/decision.ts"]
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch
  });

  const evidence = await adapter.recall({ task: "architectural decision", root: "/repo" });

  assert.deepEqual(urls, [
    "http://memory.test/agentmemory/smart-search",
    "http://memory.test/agentmemory/memories/mem-compact"
  ]);
  assert.equal(evidence[0]?.content, "Full architectural decision");
  assert.equal(evidence[0]?.score, 0.8);
  assert.equal(evidence[0]?.path, "src/decision.ts");
});

test("returns empty evidence for a successful search with no memories", async () => {
  const adapter = new AgentMemoryHttpAdapter({
    fetch: (async () => new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch
  });

  assert.deepEqual(await adapter.recall({ task: "new task", root: "/repo" }), []);
});

test("surfaces AgentMemory HTTP failures", async () => {
  const adapter = new AgentMemoryHttpAdapter({
    fetch: (async () => new Response("engine offline", { status: 503 })) as typeof fetch
  });

  await assert.rejects(
    adapter.recall({ task: "remember this", root: "/repo" }),
    /503: engine offline/
  );
});


test("includes the active LCA session in smart-search", async () => {
  let requestBody: Record<string, unknown> = {};
  const adapter = new AgentMemoryHttpAdapter({
    projectId: () => "project-one",
    sessionIdForRoot: async () => "session-one",
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch
  });

  await adapter.recall({ task: "trace session", root: "/repo" });

  assert.equal(requestBody.sessionId, "session-one");
  assert.equal(requestBody.project, "project-one");
});

test("writes AgentMemory session lifecycle endpoints", async () => {
  const requests: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  const adapter = new AgentMemoryHttpAdapter({
    baseUrl: "http://memory.test",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        pathname: new URL(String(url)).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : {}
      });
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch
  });

  await adapter.startSession({
    sessionId: "session-one",
    project: "project-one",
    cwd: "/repo",
    title: "Trace lifecycle",
    agentId: "lca"
  });
  await adapter.observe({
    hookType: "post_tool_use",
    sessionId: "session-one",
    project: "project-one",
    cwd: "/repo",
    timestamp: "2026-07-22T00:00:00.000Z",
    data: { tool_name: "workspace_read" }
  });
  await adapter.remember({
    content: "Session summary",
    project: "project-one",
    type: "session_summary",
    concepts: ["lca-session"],
    files: ["src/main.ts"]
  });
  await adapter.endSession("session-one");

  assert.deepEqual(requests.map((request) => request.pathname), [
    "/agentmemory/session/start",
    "/agentmemory/observe",
    "/agentmemory/remember",
    "/agentmemory/session/end"
  ]);
  assert.equal(requests[0]?.body.sessionId, "session-one");
  assert.equal((requests[1]?.body.data as Record<string, unknown>).tool_name, "workspace_read");
  assert.equal(requests[2]?.body.type, "session_summary");
  assert.deepEqual(requests[3]?.body, { sessionId: "session-one" });
});


test("lists AgentMemory sessions for stale-session reconciliation", async () => {
  let requestedUrl = "";
  const adapter = new AgentMemoryHttpAdapter({
    baseUrl: "http://memory.test",
    fetch: (async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({
        sessions: [{ id: "lca-123-old", project: "project-one", status: "active", agentId: "lca" }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch
  });

  const sessions = await adapter.listSessions();

  assert.equal(requestedUrl, "http://memory.test/agentmemory/sessions?limit=500");
  assert.equal(sessions[0]?.id, "lca-123-old");
});
