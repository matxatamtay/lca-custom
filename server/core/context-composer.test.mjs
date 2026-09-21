import assert from "node:assert/strict";
import test from "node:test";
import { composeTaskContext } from "./context-composer.mjs";

const providers = ["filesystem", "semantic", "codegraph", "agentmemory"];

function evidence(provider, index = 0, chars = 300) {
  return {
    id: `${provider}-${index}`,
    provider,
    kind: provider === "agentmemory" ? "memory" : "text",
    title: `${provider} ${index}`,
    content: `${provider}:`.padEnd(chars, String(index || 1)),
    score: 100 - index
  };
}

function baseContext(items) {
  return {
    contextId: "ctx",
    task: "implement feature",
    root: "/repo",
    generatedAt: "2026-09-17T00:00:00Z",
    coverage: Object.fromEntries(providers.map((provider) => [provider, { queried: true, status: "ok", hits: items.filter((item) => item.provider === provider).length, latencyMs: 1 }])),
    evidence: items
  };
}

test("small budgets keep high-priority task state and one evidence item per available provider", () => {
  const items = providers.flatMap((provider) => [evidence(provider, 0, 600), evidence(provider, 1, 600)]);
  const result = composeTaskContext({
    context: baseContext(items),
    taskState: {
      goal: "Finish M6 context composition",
      status: "active",
      steps: [{ text: "compose", done: false }, { text: "verify", done: false }],
      changed_files: ["server/a.ts", "server/b.ts"],
      blockers: [{ text: "none" }],
      decisions: [{ decision: "Keep four providers", why: "coverage" }]
    },
    checkpoint: { saved_at: "2026-09-17T00:00:00Z", reason: "edit" },
    maxItems: 3,
    maxChars: 1_000
  });
  assert.equal(result.state_context.task.goal, "Finish M6 context composition");
  assert.equal(new Set(result.evidence.map((item) => item.provider)).size, 4);
  assert.equal(result.composition.budget.effective_items, 4);
  assert.ok(result.composition.budget.used_chars <= 1_000);
});

test("unused local-state reservation is reclaimed by provider evidence", () => {
  const items = providers.map((provider) => evidence(provider, 0, 2_000));
  const result = composeTaskContext({
    context: baseContext(items),
    taskState: { goal: "Short goal", status: "active", steps: [] },
    maxItems: 10,
    maxChars: 8_000
  });
  assert.ok(result.composition.budget.reclaimed_state_chars > 0);
  assert.ok(result.composition.budget.evidence_budget_chars > 6_000);
  assert.equal(result.evidence.length, 4);
});

test("state composition deduplicates changed files and prioritizes blockers/decisions over discoveries", () => {
  const result = composeTaskContext({
    context: baseContext([evidence("filesystem", 0, 100)]),
    taskState: {
      goal: "Goal",
      status: "active",
      steps: [{ text: "pending", done: false }],
      changed_files: ["a.ts", "a.ts", "b.ts"],
      blockers: [{ text: "blocked by API" }],
      decisions: [{ decision: "Use adapter", why: "isolation" }],
      discoveries: Array.from({ length: 20 }, (_, index) => ({ text: `discovery ${index}` }))
    },
    requestChangedFiles: ["a.ts"],
    maxItems: 5,
    maxChars: 1_400
  });
  assert.deepEqual(result.state_context.changed_files, ["a.ts", "b.ts"]);
  assert.match(JSON.stringify(result.state_context.blockers), /blocked by API/);
  assert.match(JSON.stringify(result.state_context.decisions), /Use adapter/);
});

test("provider evidence is deduplicated and local-state absence returns a clean fallback", () => {
  const duplicate = evidence("filesystem", 0, 100);
  const result = composeTaskContext({
    context: baseContext([duplicate, { ...duplicate }, evidence("codegraph", 0, 100)]),
    maxItems: 10,
    maxChars: 4_000
  });
  assert.equal(result.state_context, null);
  assert.equal(result.composition.local_state.available, false);
  assert.equal(result.evidence.filter((item) => item.provider === "filesystem").length, 1);
  assert.deepEqual(new Set(result.evidence.map((item) => item.provider)), new Set(["filesystem", "codegraph"]));
});

test("compacts duplicate semantic symbols and bounds noisy provider candidates", () => {
  const semanticA = { ...evidence("semantic", 0, 300), symbol: "RetryCoordinator", path: "tests/retry.test.ts", metadata: { definition_count: 1, reference_count: 4 } };
  const semanticB = { ...evidence("semantic", 1, 300), symbol: "RetryCoordinator", path: "src/retry.ts", metadata: { definition_count: 1, reference_count: 6 } };
  const files = Array.from({ length: 12 }, (_, index) => ({ ...evidence("filesystem", index, 120), path: `src/file-${index}.ts` }));
  const result = composeTaskContext({
    context: baseContext([...files, semanticA, semanticB, evidence("codegraph", 0, 200)]),
    maxItems: 20,
    maxChars: 12_000
  });

  assert.equal(result.evidence.filter((item) => item.provider === "semantic").length, 1);
  assert.equal(result.evidence.find((item) => item.provider === "semantic")?.path, "src/retry.ts");
  assert.ok(result.evidence.filter((item) => item.provider === "filesystem").length <= 8);
  assert.ok(result.composition.compaction.dropped_items >= 5);
});
