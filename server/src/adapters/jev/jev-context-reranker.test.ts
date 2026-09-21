import test from "node:test";
import assert from "node:assert/strict";

import type { ContextEvidence } from "../../domain/task-context.js";
import {
  JevContextReranker,
  createOptionalJevContextReranker
} from "./jev-context-reranker.js";

function evidence(id: string, score: number, path = `/repo/src/${id}.ts`): ContextEvidence {
  return {
    id,
    provider: "filesystem",
    kind: "text",
    title: id,
    content: `export function ${id}() {}`,
    path,
    score
  };
}

test("missing api token disables Jev cleanly", () => {
  assert.equal(createOptionalJevContextReranker({ apiToken: "" }), undefined);
  assert.equal(createOptionalJevContextReranker({ enabled: false, apiToken: "secret" }), undefined);
  assert.equal(createOptionalJevContextReranker({
    apiToken: "secret",
    endpoint: "not a valid URL"
  }), undefined);
});

test("applies Jev score decisions as bounded boosts without dropping evidence", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const reranker = new JevContextReranker({
    apiToken: "test-token",
    fetch: (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          candidate_0: { type: "score", score: 0, confidence: 0.9 },
          candidate_1: { type: "score", score: 2, confidence: 1.0 },
          context_sufficiency: { type: "score", score: 2, confidence: 0.88 }
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch
  });

  const items = [evidence("already-high", 80), evidence("direct-hit", 60)];
  const result = await reranker.rerank(
    { task: "Fix direct-hit implementation", root: "/repo", intent: "implement" },
    items
  );

  assert.equal(result.ranking.provider, "jev");
  assert.equal(result.ranking.status, "applied");
  assert.equal(result.ranking.sufficiency, "sufficient");
  assert.equal(result.ranking.sufficiencyConfidence, 0.88);
  assert.equal(result.ranking.candidateCap, 24);
  assert.ok(Number(result.ranking.stateChars) > 0);
  assert.equal(result.evidence.length, 2);
  assert.equal(result.evidence[0]?.score, 80);
  assert.equal(result.evidence[1]?.score, 90);
  assert.equal(
    (result.evidence[1]?.metadata?.jevRerank as { confidence?: number } | undefined)?.confidence,
    1
  );
  assert.equal(requestBody?.model, "jev-latest");
  assert.ok(String(requestBody?.state).includes("[candidate_0]"));
});

test("HTTP failures fall back to unchanged rule ranking", async () => {
  const items = [evidence("a", 20), evidence("b", 10)];
  const reranker = new JevContextReranker({
    apiToken: "bad-token",
    fetch: (async () => new Response("unauthorized", { status: 401 })) as typeof fetch
  });

  const result = await reranker.rerank({ task: "inspect", root: "/repo" }, items);

  assert.equal(result.ranking.provider, "rule");
  assert.equal(result.ranking.status, "fallback");
  assert.equal(result.ranking.fallbackReason, "http-401");
  assert.deepEqual(result.evidence, items);
});

test("malformed Jev responses fall back instead of partially reranking", async () => {
  const items = [evidence("a", 20), evidence("b", 10)];
  const reranker = new JevContextReranker({
    apiToken: "token",
    fetch: (async () => new Response(JSON.stringify({
      answers: {
        candidate_0: { type: "score", score: 2, confidence: 1 }
      }
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch
  });

  const result = await reranker.rerank({ task: "inspect", root: "/repo" }, items);

  assert.equal(result.ranking.status, "fallback");
  assert.equal(result.ranking.fallbackReason, "malformed-answer");
  assert.deepEqual(result.evidence, items);
});

test("circuit breaker avoids repeated remote calls after consecutive failures", async () => {
  let calls = 0;
  let now = 1_000;
  const items = [evidence("a", 20), evidence("b", 10)];
  const reranker = new JevContextReranker({
    apiToken: "token",
    circuitFailures: 2,
    circuitOpenMs: 5_000,
    now: () => now,
    fetch: (async () => {
      calls += 1;
      return new Response("busy", { status: 503 });
    }) as typeof fetch
  });

  await reranker.rerank({ task: "inspect", root: "/repo" }, items);
  await reranker.rerank({ task: "inspect", root: "/repo" }, items);
  const third = await reranker.rerank({ task: "inspect", root: "/repo" }, items);

  assert.equal(calls, 2);
  assert.equal(third.ranking.fallbackReason, "circuit-open");

  now += 5_001;
  await reranker.rerank({ task: "inspect", root: "/repo" }, items);
  assert.equal(calls, 3);
});

test("sensitive files are never sent to Jev", async () => {
  let calls = 0;
  const reranker = new JevContextReranker({
    apiToken: "token",
    fetch: (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch
  });

  const result = await reranker.rerank(
    { task: "inspect config", root: "/repo" },
    [
      evidence("env", 100, "/repo/.env.local"),
      evidence("key", 90, "/repo/private.pem")
    ]
  );

  assert.equal(calls, 0);
  assert.equal(result.ranking.status, "skipped");
  assert.equal(result.ranking.fallbackReason, "no-remote-safe-candidates");
});

test("state budget never asks Jev about candidates omitted from state", async () => {
  let body: Record<string, unknown> | undefined;
  const reranker = new JevContextReranker({
    apiToken: "token",
    maxStateChars: 2_000,
    maxCandidates: 24,
    fetch: (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const questions = body.questions as Record<string, unknown>;
      const answers = Object.fromEntries(
        Object.keys(questions).map((key) => [key, { type: "score", score: 1, confidence: 0.9 }])
      );
      return new Response(JSON.stringify({ answers }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch
  });

  const items = Array.from({ length: 24 }, (_, index) =>
    evidence(`candidate-${index}`, 100 - index)
  );
  const result = await reranker.rerank({ task: "inspect candidates", root: "/repo" }, items);

  assert.equal(result.ranking.status, "applied");
  assert.equal(result.ranking.candidateCap, 24);
  assert.equal(result.ranking.stateChars, String(body?.state ?? "").length);
  const state = String(body?.state ?? "");
  const questions = body?.questions as Record<string, unknown>;
  const candidateKeys = Object.keys(questions).filter((key) => key.startsWith("candidate_"));
  for (const key of candidateKeys) {
    assert.ok(state.includes(`[${key}]`));
  }
  assert.ok(candidateKeys.length < items.length);
  assert.ok("context_sufficiency" in questions);
});
