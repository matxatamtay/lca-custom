import test from "node:test";
import assert from "node:assert/strict";

import { BuildTaskContext } from "./build-task-context.js";
import { ContextProviderUnavailableError, type ContextEvidence } from "../../domain/task-context.js";

function evidence(provider: ContextEvidence["provider"], id: string, content = id): ContextEvidence {
  return {
    id,
    provider,
    kind: provider === "agentmemory" ? "memory" : "text",
    title: id,
    content,
    score: 10
  };
}

function semanticProvider(items: readonly ContextEvidence[] = []) {
  return {
    async context() {
      return {
        evidence: items,
        language: "typescript" as const,
        engine: "test-semantic",
        available: true
      };
    }
  };
}

test("queries filesystem, semantic analysis, CodeGraph, and AgentMemory for every task context", async () => {
  const calls: string[] = [];
  const useCase = new BuildTaskContext({
    filesystem: {
      async search() {
        calls.push("filesystem");
        return [evidence("filesystem", "file-hit")];
      }
    },
    semantic: {
      async context() {
        calls.push("semantic");
        return {
          evidence: [evidence("semantic", "semantic-hit")],
          language: "typescript" as const,
          engine: "test-semantic",
          available: true
        };
      }
    },
    codegraph: {
      async ensureIndexed() {
        calls.push("codegraph.ensureIndexed");
      },
      async context() {
        calls.push("codegraph.context");
        return [evidence("codegraph", "graph-hit")];
      },
      telemetry() {
        return { index_ms: 3, query_ms: 4, cache_hit: true, route: "search" };
      }
    },
    agentmemory: {
      async recall() {
        calls.push("agentmemory");
        return [evidence("agentmemory", "memory-hit")];
      }
    },
    now: () => new Date("2026-07-22T00:00:00.000Z"),
    createId: () => "ctx-test"
  });

  const result = await useCase.execute({ task: "Trace the payment retry flow", root: "/repo" });

  assert.deepEqual(calls.sort(), [
    "agentmemory",
    "codegraph.context",
    "codegraph.ensureIndexed",
    "filesystem",
    "semantic"
  ]);
  assert.equal(result.contextId, "ctx-test");
  assert.equal(result.coverage.filesystem.queried, true);
  assert.equal(result.coverage.semantic.queried, true);
  assert.equal(result.coverage.semantic.status, "ok");
  assert.equal(result.coverage.codegraph.queried, true);
  assert.equal(result.coverage.codegraph.details?.index_ms, 3);
  assert.equal(result.coverage.codegraph.details?.query_ms, 4);
  assert.equal(result.coverage.codegraph.details?.cache_hit, true);
  assert.equal(result.coverage.agentmemory.queried, true);
  assert.equal(result.evidence.length, 4);
});

test("records AgentMemory coverage even when memory has no hits", async () => {
  const useCase = new BuildTaskContext({
    filesystem: { async search() { return []; } },
    semantic: semanticProvider(),
    codegraph: {
      async ensureIndexed() {},
      async context() { return []; }
    },
    agentmemory: { async recall() { return []; } }
  });

  const result = await useCase.execute({ task: "Understand startup", root: "/repo" });

  assert.equal(result.coverage.agentmemory.queried, true);
  assert.equal(result.coverage.agentmemory.hits, 0);
});

test("fails loudly when a required provider is unavailable while still starting all providers", async () => {
  const calls: string[] = [];
  const useCase = new BuildTaskContext({
    filesystem: {
      async search() {
        calls.push("filesystem");
        return [];
      }
    },
    semantic: semanticProvider(),
    codegraph: {
      async ensureIndexed() {
        calls.push("codegraph.ensureIndexed");
        throw new Error("index service offline");
      },
      async context() {
        calls.push("codegraph.context");
        return [];
      }
    },
    agentmemory: {
      async recall() {
        calls.push("agentmemory");
        return [];
      }
    }
  });

  await assert.rejects(
    useCase.execute({ task: "Find impacted callers", root: "/repo" }),
    (error: unknown) => error instanceof ContextProviderUnavailableError && error.provider === "codegraph"
  );

  assert.ok(calls.includes("filesystem"));
  assert.ok(calls.includes("agentmemory"));
  assert.ok(calls.includes("codegraph.ensureIndexed"));
  assert.equal(calls.includes("codegraph.context"), false);
});

test("keeps evidence from every provider and ranks current filesystem evidence first", async () => {
  const duplicateContent = "POST /v2/statistics";
  const useCase = new BuildTaskContext({
    filesystem: {
      async search() {
        return [evidence("filesystem", "current", duplicateContent)];
      }
    },
    semantic: semanticProvider([evidence("semantic", "semantic")]),
    codegraph: {
      async ensureIndexed() {},
      async context() {
        return [evidence("codegraph", "graph", duplicateContent)];
      }
    },
    agentmemory: {
      async recall() {
        return [evidence("agentmemory", "old-memory", duplicateContent)];
      }
    }
  });

  const result = await useCase.execute({ task: "Find statistics endpoint", root: "/repo" });

  assert.equal(result.evidence.length, 4);
  assert.deepEqual(result.evidence.map((item) => item.provider), [
    "filesystem",
    "semantic",
    "codegraph",
    "agentmemory"
  ]);
});

test("keeps provider evidence even when providers reuse the same external id", async () => {
  const sharedId = "shared-id";
  const useCase = new BuildTaskContext({
    filesystem: { async search() { return [evidence("filesystem", sharedId, "file")]; } },
    semantic: semanticProvider([evidence("semantic", sharedId, "semantic")]),
    codegraph: {
      async ensureIndexed() {},
      async context() { return [evidence("codegraph", sharedId, "graph")]; }
    },
    agentmemory: { async recall() { return [evidence("agentmemory", sharedId, "memory")]; } }
  });

  const result = await useCase.execute({ task: "shared ids", root: "/repo" });

  assert.equal(result.evidence.length, 4);
});

test("reserves one result per provider before filling the remaining budget", async () => {
  const useCase = new BuildTaskContext({
    filesystem: {
      async search() {
        return Array.from({ length: 10 }, (_, index) => ({
          ...evidence("filesystem", `file-${index}`),
          score: 100 - index
        }));
      }
    },
    semantic: semanticProvider([evidence("semantic", "semantic")]),
    codegraph: {
      async ensureIndexed() {},
      async context() { return [evidence("codegraph", "graph")]; }
    },
    agentmemory: {
      async recall() { return [evidence("agentmemory", "memory")]; }
    }
  });

  const result = await useCase.execute({
    task: "Find all providers",
    root: "/repo",
    budget: { maxItems: 5 }
  });

  assert.equal(result.evidence.length, 5);
  assert.ok(result.evidence.some((item) => item.provider === "filesystem"));
  assert.ok(result.evidence.some((item) => item.provider === "semantic"));
  assert.ok(result.evidence.some((item) => item.provider === "codegraph"));
  assert.ok(result.evidence.some((item) => item.provider === "agentmemory"));
});

test("keeps semantic capability failure visible without blocking required providers", async () => {
  const useCase = new BuildTaskContext({
    filesystem: { async search() { return [evidence("filesystem", "file")]; } },
    semantic: {
      async context() {
        return {
          evidence: [],
          language: "java" as const,
          engine: null,
          available: false,
          reason: "java semantic engine is not registered yet."
        };
      }
    },
    codegraph: {
      async ensureIndexed() {},
      async context() { return [evidence("codegraph", "graph")]; }
    },
    agentmemory: { async recall() { return []; } }
  });

  const result = await useCase.execute({ task: "Trace Java service", root: "/repo" });

  assert.equal(result.coverage.semantic.status, "unavailable");
  assert.equal(result.coverage.semantic.details?.language, "java");
  assert.match(String(result.coverage.semantic.details?.reason), /not registered/);
  assert.ok(result.evidence.some((item) => item.provider === "codegraph"));
});

test("optional reranker can improve ordering while preserving provider membership", async () => {
  const useCase = new BuildTaskContext({
    filesystem: {
      async search() {
        return [{ ...evidence("filesystem", "file"), score: 50 }];
      }
    },
    semantic: semanticProvider([{ ...evidence("semantic", "semantic"), score: 60 }]),
    codegraph: {
      async ensureIndexed() {},
      async context() { return [{ ...evidence("codegraph", "graph"), score: 40 }]; }
    },
    agentmemory: {
      async recall() { return [{ ...evidence("agentmemory", "memory"), score: 30 }]; }
    },
    reranker: {
      async rerank(_request, items) {
        return {
          evidence: items.map((item) => item.id === "graph" ? { ...item, score: 100 } : item),
          ranking: {
            provider: "jev" as const,
            status: "applied" as const,
            latencyMs: 10,
            model: "jev-latest",
            candidates: items.length,
            accepted: 1
          }
        };
      }
    }
  });

  const result = await useCase.execute({ task: "Find graph relation", root: "/repo" });

  assert.equal(result.evidence[0]?.id, "graph");
  assert.equal(result.ranking?.provider, "jev");
  assert.deepEqual(
    new Set(result.evidence.map((item) => item.provider)),
    new Set(["filesystem", "semantic", "codegraph", "agentmemory"])
  );
});

test("unexpected reranker errors transparently fall back to existing ranking", async () => {
  const useCase = new BuildTaskContext({
    filesystem: { async search() { return [{ ...evidence("filesystem", "file"), score: 50 }]; } },
    semantic: semanticProvider([{ ...evidence("semantic", "semantic"), score: 40 }]),
    codegraph: {
      async ensureIndexed() {},
      async context() { return [{ ...evidence("codegraph", "graph"), score: 30 }]; }
    },
    agentmemory: {
      async recall() { return [{ ...evidence("agentmemory", "memory"), score: 20 }]; }
    },
    reranker: {
      async rerank() {
        throw new Error("jev offline");
      }
    }
  });

  const result = await useCase.execute({ task: "Inspect startup", root: "/repo" });

  assert.equal(result.evidence[0]?.id, "file");
  assert.equal(result.ranking?.provider, "rule");
  assert.equal(result.ranking?.status, "fallback");
  assert.equal(result.ranking?.fallbackReason, "reranker-error");
});

test("prunes only confidently irrelevant Jev evidence after reranking", async () => {
  const useCase = new BuildTaskContext({
    filesystem: {
      async search() {
        return [
          { ...evidence("filesystem", "useful-file"), score: 50 },
          { ...evidence("filesystem", "noise-file"), score: 49 }
        ];
      }
    },
    semantic: semanticProvider([{ ...evidence("semantic", "uncertain-semantic"), score: 40 }]),
    codegraph: {
      async ensureIndexed() {},
      async context() { return [{ ...evidence("codegraph", "noise-graph"), score: 30 }]; }
    },
    agentmemory: {
      async recall() { return [{ ...evidence("agentmemory", "local-memory"), score: 20 }]; }
    },
    reranker: {
      async rerank(_request, items) {
        return {
          evidence: items.map((item) => {
            if (item.id === "noise-file" || item.id === "noise-graph") {
              return {
                ...item,
                metadata: {
                  ...(item.metadata ?? {}),
                  jevRerank: {
                    model: "jev-latest",
                    relevance: 0,
                    score: 0,
                    confidence: 0.95,
                    boost: 0
                  }
                }
              };
            }
            if (item.id === "useful-file") {
              return {
                ...item,
                metadata: {
                  ...(item.metadata ?? {}),
                  jevRerank: {
                    model: "jev-latest",
                    relevance: 1,
                    score: 2,
                    confidence: 0.9,
                    boost: 27
                  }
                }
              };
            }
            return item;
          }),
          ranking: {
            provider: "jev" as const,
            status: "applied" as const,
            latencyMs: 12,
            candidates: items.length,
            accepted: 3,
            sufficiency: "partial" as const,
            sufficiencyConfidence: 0.8
          }
        };
      }
    }
  });

  const result = await useCase.execute({ task: "Trace relevant code", root: "/repo" });

  assert.deepEqual(result.evidence.map((item) => item.id), ["useful-file", "uncertain-semantic", "local-memory"]);
  assert.equal(result.evidence.some((item) => item.provider === "codegraph"), false);
  assert.equal(result.ranking?.pruned, 2);
  assert.equal(result.ranking?.sufficiency, "partial");
});
