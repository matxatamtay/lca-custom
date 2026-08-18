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

test("queries filesystem, CodeGraph, and AgentMemory for every task context", async () => {
  const calls: string[] = [];
  const useCase = new BuildTaskContext({
    filesystem: {
      async search() {
        calls.push("filesystem");
        return [evidence("filesystem", "file-hit")];
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
    "filesystem"
  ]);
  assert.equal(result.contextId, "ctx-test");
  assert.equal(result.coverage.filesystem.queried, true);
  assert.equal(result.coverage.codegraph.queried, true);
  assert.equal(result.coverage.agentmemory.queried, true);
  assert.equal(result.evidence.length, 3);
});

test("records AgentMemory coverage even when memory has no hits", async () => {
  const useCase = new BuildTaskContext({
    filesystem: { async search() { return []; } },
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

  assert.equal(result.evidence.length, 3);
  assert.deepEqual(result.evidence.map((item) => item.provider), [
    "filesystem",
    "codegraph",
    "agentmemory"
  ]);
});

test("keeps provider evidence even when providers reuse the same external id", async () => {
  const sharedId = "shared-id";
  const useCase = new BuildTaskContext({
    filesystem: { async search() { return [evidence("filesystem", sharedId, "file")]; } },
    codegraph: {
      async ensureIndexed() {},
      async context() { return [evidence("codegraph", sharedId, "graph")]; }
    },
    agentmemory: { async recall() { return [evidence("agentmemory", sharedId, "memory")]; } }
  });

  const result = await useCase.execute({ task: "shared ids", root: "/repo" });

  assert.equal(result.evidence.length, 3);
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
  assert.ok(result.evidence.some((item) => item.provider === "codegraph"));
  assert.ok(result.evidence.some((item) => item.provider === "agentmemory"));
});

test("reranks filesystem evidence referenced by CodeGraph ahead of unrelated matches", async () => {
  const useCase = new BuildTaskContext({
    filesystem: {
      async search() {
        return [
          { ...evidence("filesystem", "unrelated", "context implementation"), path: "/repo/docs/context.md", score: 100 },
          { ...evidence("filesystem", "source", "context implementation"), path: "/repo/src/context.ts", score: 100 }
        ];
      }
    },
    codegraph: {
      async ensureIndexed() {},
      async context() {
        return [{ ...evidence("codegraph", "graph", "BuildTaskContext at src/context.ts:20"), path: "/repo/src/context.ts" }];
      }
    },
    agentmemory: { async recall() { return []; } }
  });

  const result = await useCase.execute({ task: "context implementation", root: "/repo", budget: { maxItems: 4 } });
  const filesystem = result.evidence.filter((item) => item.provider === "filesystem");
  assert.equal(filesystem[0]?.path, "/repo/src/context.ts");
});

test("enforces the global character budget", async () => {
  const long = "x".repeat(2_000);
  const useCase = new BuildTaskContext({
    filesystem: { async search() { return [evidence("filesystem", "file", long)]; } },
    codegraph: { async ensureIndexed() {}, async context() { return [evidence("codegraph", "graph", long)]; } },
    agentmemory: { async recall() { return [evidence("agentmemory", "memory", long)]; } }
  });

  const result = await useCase.execute({ task: "budget test", root: "/repo", budget: { maxItems: 3, maxChars: 1_200 } });
  const used = result.evidence.reduce((sum, item) => sum + item.content.length + item.title.length + (item.path?.length ?? 0) + 40, 0);
  assert.ok(result.evidence.length >= 1);
  assert.ok(used <= 1_200);
});
