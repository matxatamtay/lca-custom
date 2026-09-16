import test from "node:test";
import assert from "node:assert/strict";

import {
  CodeGraphAdapter,
  type CodeGraphIndexReceipt
} from "./codegraph-adapter.js";
import { PersistentMcpToolClient } from "../../infrastructure/mcp/persistent-mcp-tool-client.js";

function receipt(root: string, revision = "rev-1"): CodeGraphIndexReceipt {
  return { root, revision, synced: true, checkedAt: Date.now() };
}

function createAdapter(options: {
  responses?: Readonly<Record<string, string>>;
  indexer?: { ensureIndexed(root: string, changedFiles?: readonly string[]): Promise<CodeGraphIndexReceipt> };
}) {
  const calls: Array<{ name: string; arguments: Readonly<Record<string, unknown>> }> = [];
  const client = new PersistentMcpToolClient(async () => ({
    async callTool(input) {
      calls.push(input);
      return {
        content: [{ type: "text", text: options.responses?.[input.name] ?? `${input.name} result` }]
      };
    },
    async close() {}
  }));
  const indexCalls: Array<{ root: string; changedFiles: readonly string[] }> = [];
  const indexer = options.indexer ?? {
    async ensureIndexed(root: string, changedFiles: readonly string[] = []) {
      indexCalls.push({ root, changedFiles });
      return receipt(root);
    }
  };
  return { adapter: new CodeGraphAdapter({ client, indexer }), calls, indexCalls };
}

test("routes structural flow tasks to bounded CodeGraph explore", async () => {
  const { adapter, calls } = createAdapter({ responses: { codegraph_explore: "Blast radius\nserver/src/example.ts" } });
  await adapter.ensureIndexed("/repo");
  const evidence = await adapter.context({
    task: "Trace startup flow across modules",
    root: "/repo",
    changedFiles: ["server.ts"],
    budget: { maxItems: 5 }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "codegraph_explore");
  assert.equal(calls[0]?.arguments.projectPath, "/repo");
  assert.ok(Number(calls[0]?.arguments.maxFiles) <= 5);
  assert.equal(evidence[0]?.provider, "codegraph");
  assert.match(evidence[0]?.content ?? "", /Blast radius/);
  assert.equal(evidence[0]?.metadata?.mode, "deep");
});

test("routes ordinary named-symbol tasks to location-only CodeGraph search", async () => {
  const { adapter, calls } = createAdapter({ responses: { codegraph_search: "PromotionRepo — core/src/PromotionRepo.java:10" } });
  await adapter.ensureIndexed("/repo");
  const evidence = await adapter.context({ task: "Fix PromotionRepo filtering", root: "/repo" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "codegraph_search");
  assert.equal(calls[0]?.arguments.query, "PromotionRepo");
  assert.equal(evidence[0]?.metadata?.mode, "search");
  assert.doesNotMatch(evidence[0]?.content ?? "", /verbatim source/i);
});

test("routes refactors to CodeGraph impact instead of full source exploration", async () => {
  const { adapter, calls } = createAdapter({ responses: { codegraph_impact: "Affected symbols: 7" } });
  await adapter.ensureIndexed("/repo");
  const evidence = await adapter.context({
    task: "Refactor PromotionRepo safely",
    root: "/repo",
    intent: "refactor"
  });

  assert.equal(calls[0]?.name, "codegraph_impact");
  assert.equal(calls[0]?.arguments.symbol, "PromotionRepo");
  assert.equal(calls[0]?.arguments.depth, 2);
  assert.equal(evidence[0]?.metadata?.mode, "impact");
});

test("reuses CodeGraph evidence only while the graph revision is unchanged", async () => {
  const { adapter, calls } = createAdapter({ responses: { codegraph_search: "PromotionRepo location" } });
  await adapter.ensureIndexed("/repo");

  const first = await adapter.context({ task: "Fix PromotionRepo", root: "/repo" });
  const second = await adapter.context({ task: "Fix PromotionRepo", root: "/repo" });

  assert.equal(calls.length, 1);
  assert.equal(first[0]?.metadata?.cache_hit, false);
  assert.equal(second[0]?.metadata?.cache_hit, true);
});

test("changed files force index refresh and invalidate prior revision cache", async () => {
  let generation = 0;
  const seenChanges: readonly string[][] = [];
  const mutableChanges: string[][] = [];
  const { adapter, calls } = createAdapter({
    responses: { codegraph_search: "PromotionRepo location" },
    indexer: {
      async ensureIndexed(root, changedFiles = []) {
        mutableChanges.push([...changedFiles]);
        generation += 1;
        return receipt(root, `rev-${generation}`);
      }
    }
  });
  void seenChanges;

  await adapter.ensureIndexed("/repo");
  await adapter.context({ task: "Fix PromotionRepo", root: "/repo" });
  await adapter.ensureIndexed("/repo", ["core/src/PromotionRepo.java"]);
  await adapter.context({ task: "Fix PromotionRepo", root: "/repo" });

  assert.deepEqual(mutableChanges, [[], ["core/src/PromotionRepo.java"]]);
  assert.equal(calls.length, 2);
});

test("returns no evidence when CodeGraph has no text result", async () => {
  const client = new PersistentMcpToolClient(async () => ({
    async callTool() { return { content: [] }; },
    async close() {}
  }));
  const adapter = new CodeGraphAdapter({
    client,
    indexer: { async ensureIndexed(root) { return receipt(root); } }
  });
  await adapter.ensureIndexed("/repo");

  assert.deepEqual(await adapter.context({ task: "Nothing useful here", root: "/repo" }), []);
});
