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
