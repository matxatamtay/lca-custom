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
  assert.equal(evidence[0]?.metadata?.raw_score, 0.8);
  assert.equal(evidence[0]?.path, "src/decision.ts");
  assert.ok((evidence[0]?.score ?? 0) > 0.8);
});

test("filters cross-project observation hits even when AgentMemory smart-search ignores project", async () => {
  const requests: string[] = [];
  const adapter = new AgentMemoryHttpAdapter({
    baseUrl: "http://memory.test",
    projectId: () => "project-b",
    sessionIdForRoot: async () => "session-b-current",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      requests.push(target);
      if (target.endsWith("/agentmemory/sessions?limit=500")) {
        return new Response(JSON.stringify({
          sessions: [
            { id: "session-a-old", project: "project-a", status: "completed" },
            { id: "session-b-old", project: "project-b", status: "completed" },
            { id: "session-b-current", project: "project-b", status: "active" }
          ]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (Array.isArray(body.expandIds)) {
        return new Response(JSON.stringify({
          results: body.expandIds.map((entry: { obsId: string; sessionId?: string }) => ({
            obsId: entry.obsId,
            sessionId: entry.sessionId,
            observation: {
              id: entry.obsId,
              sessionId: entry.sessionId,
              title: entry.obsId,
              narrative: `hydrated ${entry.obsId}`
            }
          }))
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        results: [
          { obsId: "wrong-project", sessionId: "session-a-old", title: "wrong", score: 0.99 },
          { obsId: "same-project-old", sessionId: "session-b-old", title: "same", score: 0.9 },
          { obsId: "current-project", sessionId: "session-b-current", title: "current", score: 0.8 }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch
  });

  const evidence = await adapter.recall({ task: "scope memory", root: "/repo-b", budget: { maxItems: 5 } });

  assert.deepEqual(evidence.map((item) => item.id), ["same-project-old", "current-project"]);
  assert.ok(requests.some((url) => url.endsWith("/agentmemory/sessions?limit=500")));
  assert.equal(evidence.every((item) => item.metadata?.project === "project-b"), true);
});

test("drops hydrated memories and lessons with an explicit mismatched project", async () => {
  const adapter = new AgentMemoryHttpAdapter({
    baseUrl: "http://memory.test",
    projectId: () => "project-b",
    fetch: (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/agentmemory/memories/mem-wrong")) {
        return new Response(JSON.stringify({
          memory: { id: "mem-wrong", project: "project-a", content: "wrong memory" }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        results: [{ obsId: "mem-wrong", sessionId: "memory", title: "wrong memory", score: 0.9 }],
        lessons: [{ id: "lesson-wrong", project: "project-a", content: "wrong lesson" }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch
  });

  const evidence = await adapter.recall({ task: "scope direct memory", root: "/repo-b" });
  assert.deepEqual(evidence, []);
});

test("tiers durable decisions above summaries, tasks, and raw observations", async () => {
  const now = Date.parse("2026-09-17T00:00:00.000Z");
  const adapter = new AgentMemoryHttpAdapter({
    now: () => now,
    fetch: (async () => new Response(JSON.stringify({
      results: [
        { id: "obs", title: "workspace_context", narrative: "raw workspace_context observation", timestamp: "2026-09-17T00:00:00.000Z", score: 0.99 },
        { id: "task", type: "task_checkpoint", content: "Next steps: verify retry", timestamp: "2026-09-17T00:00:00.000Z", score: 0.95 },
        { id: "summary", type: "session_summary", content: "LCA session summary for repo", timestamp: "2026-09-10T00:00:00.000Z", score: 0.9 },
        { id: "decision", type: "architectural_decision", content: "Decision: keep transaction locks", files: ["src/locks.ts"], concepts: ["transactions"], timestamp: "2026-01-01T00:00:00.000Z", score: 0.3 }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch
  });

  const evidence = await adapter.recall({ task: "transaction design", root: "/repo", budget: { maxItems: 4 } });
  assert.deepEqual(evidence.map((item) => item.id), ["decision", "summary", "task", "obs"]);
  assert.deepEqual(evidence.map((item) => item.metadata?.memory_tier), ["durable", "session_summary", "task", "observation"]);
  assert.ok((evidence[0]?.metadata?.selection_reasons as string[]).includes("explicit-decision"));
});

test("deduplicates normalized memories and reports retrieval telemetry", async () => {
  const adapter = new AgentMemoryHttpAdapter({
    fetch: (async () => new Response(JSON.stringify({
      results: [
        { id: "a", type: "fact", content: "Keep retry policy for partner X", files: ["src/retry.ts"], score: 0.9 },
        { id: "b", type: "fact", content: "  Keep   retry policy for partner X  ", files: ["src/retry.ts"], score: 0.8 },
        { id: "c", type: "fact", content: "Different durable fact", files: ["src/other.ts"], score: 0.7 }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch
  });

  const evidence = await adapter.recall({ task: "retry policy", root: "/repo", budget: { maxItems: 5 } });
  assert.equal(evidence.length, 2);
  const telemetry = evidence[0]?.metadata?.retrieval as { duplicate_dropped?: number; fetched?: number; selected?: number };
  assert.equal(telemetry.duplicate_dropped, 1);
  assert.equal(telemetry.fetched, 3);
  assert.equal(telemetry.selected, 2);
});

test("recency breaks ties within a memory tier while noisy workspace_context observations are downranked", async () => {
  const now = Date.parse("2026-09-17T00:00:00.000Z");
  const adapter = new AgentMemoryHttpAdapter({
    now: () => now,
    fetch: (async () => new Response(JSON.stringify({
      results: [
        { id: "old", type: "fact", content: "retry policy detail old", files: ["src/retry.ts"], timestamp: "2025-01-01T00:00:00.000Z", score: 0.8 },
        { id: "new", type: "fact", content: "retry policy detail new", files: ["src/retry.ts"], timestamp: "2026-09-17T00:00:00.000Z", score: 0.8 },
        { id: "noise", title: "workspace_context", narrative: "workspace_context retry policy", timestamp: "2026-09-17T00:00:00.000Z", score: 1 }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch
  });

  const evidence = await adapter.recall({ task: "retry policy", root: "/repo", budget: { maxItems: 3 } });
  assert.equal(evidence[0]?.id, "new");
  assert.equal(evidence[1]?.id, "old");
  assert.equal(evidence.at(-1)?.id, "noise");
  assert.ok((evidence.at(-1)?.metadata?.selection_reasons as string[]).includes("raw-context-noise"));
});

test("reuses exact-query recall briefly and invalidates it after memory mutation", async () => {
  let now = 1_000;
  let smartSearches = 0;
  const adapter = new AgentMemoryHttpAdapter({
    now: () => now,
    recallCacheTtlMs: 5_000,
    projectId: () => "project-one",
    fetch: (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/agentmemory/smart-search")) {
        smartSearches += 1;
        return new Response(JSON.stringify({
          results: [{ id: "mem-cache", type: "fact", content: "cached durable fact", files: ["src/a.ts"] }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch
  });

  const request = { task: "cached durable fact", root: "/repo", budget: { maxItems: 5 } } as const;
  const first = await adapter.recall(request);
  const second = await adapter.recall(request);
  assert.equal(smartSearches, 1);
  assert.equal(first[0]?.metadata?.cache_hit, undefined);
  assert.equal(second[0]?.metadata?.cache_hit, true);
  assert.equal(second[0]?.metadata?.cache_layer, "agentmemory-exact-query");

  await adapter.remember({ content: "new fact", project: "project-one" });
  await adapter.recall(request);
  assert.equal(smartSearches, 2, "memory mutation must invalidate cached recall results");

  now += 6_000;
  await adapter.recall(request);
  assert.equal(smartSearches, 3, "expired recall cache must refresh from AgentMemory");
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
