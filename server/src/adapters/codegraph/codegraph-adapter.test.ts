import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CodeGraphAdapter,
  codeGraphRelevantChangedFiles,
  changedFilesRevisionToken,
  type CodeGraphIndexReceipt
} from "./codegraph-adapter.js";
import { PersistentMcpToolClient } from "../../infrastructure/mcp/persistent-mcp-tool-client.js";

function receipt(root: string, revision = "rev-1"): CodeGraphIndexReceipt {
  return { root, revision, synced: true, checkedAt: Date.now() };
}

function createAdapter(options: {
  responses?: Readonly<Record<string, string>>;
  indexer?: { ensureIndexed(root: string, changedFiles?: readonly string[]): Promise<CodeGraphIndexReceipt> };
  rootRevision?: (root: string) => { token: string; cacheable: boolean };
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
  return {
    adapter: new CodeGraphAdapter({
      client,
      indexer,
      ...(options.rootRevision ? { rootRevision: options.rootRevision } : {})
    }),
    calls,
    indexCalls
  };
}

test("routes structural flow tasks through cheap search and callers before deep exploration", async () => {
  const { adapter, calls } = createAdapter({ responses: {
    codegraph_search: "startup — server/src/startup.ts:10",
    codegraph_callers: "Callers of startup\n- server/src/bootstrap.ts:20\n- server/src/main.ts:5\nused by 2 symbols",
    codegraph_explore: "should not run"
  } });
  await adapter.ensureIndexed("/repo");
  const evidence = await adapter.context({
    task: "Trace startup flow across modules",
    root: "/repo",
    changedFiles: ["server.ts"],
    budget: { maxItems: 5 }
  });

  assert.deepEqual(calls.map((call) => call.name), ["codegraph_search", "codegraph_callers"]);
  assert.equal(calls[0]?.arguments.projectPath, "/repo");
  assert.equal(evidence[0]?.provider, "codegraph");
  assert.match(evidence[0]?.content ?? "", /bootstrap/);
  assert.equal(evidence[0]?.metadata?.mode, "callers");
  assert.equal(evidence[0]?.metadata?.cold_router_v2, true);
  assert.deepEqual(evidence[0]?.metadata?.escalation_path, ["search", "callers"]);
});

test("deep CodeGraph context omits verbatim source dumps from the compact pack", async () => {
  const deep = [
    "**Exploration: startup flow**",
    "Found 8 symbols across 3 files.",
    "**Blast radius**",
    "- startup -> bootstrap.ts:10",
    "**Source Code**",
    "```typescript",
    "export function hugeSourceDump() { return 'not-needed-in-context'; }",
    "```"
  ].join("\n");
  const { adapter, calls } = createAdapter({ responses: { codegraph_search: "No results found for startup", codegraph_explore: deep } });
  await adapter.ensureIndexed("/repo");
  const evidence = await adapter.context({ task: "Trace startup flow across modules", root: "/repo" });

  assert.deepEqual(calls.map((call) => call.name), ["codegraph_search", "codegraph_explore"]);
  assert.match(evidence[0]?.content ?? "", /Blast radius/);
  assert.doesNotMatch(evidence[0]?.content ?? "", /hugeSourceDump/);
  assert.equal(evidence[0]?.metadata?.source_omitted, true);
  assert.deepEqual(evidence[0]?.metadata?.escalation_path, ["search", "deep"]);
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
  assert.equal(adapter.telemetry("/repo")?.cache_hit, true);
  assert.equal(adapter.telemetry("/repo")?.route, "search");
  assert.ok(Number(adapter.telemetry("/repo")?.query_ms) >= 0);
  assert.ok(Number(adapter.telemetry("/repo")?.index_ms) >= 0);
});

test("reuses staged graph searches across different task wording and refreshes on index change", async () => {
  let revision = 0;
  const { adapter, calls } = createAdapter({
    responses: {
      codegraph_search: "startup — src/startup.ts:10",
      codegraph_callers: "Callers of startup\n- src/bootstrap.ts:20\n- src/main.ts:5\nused by 2 symbols"
    },
    indexer: {
      async ensureIndexed(root) {
        revision += 1;
        return receipt(root, `rev-${revision}`);
      }
    }
  });
  await adapter.ensureIndexed("/repo");
  const first = await adapter.context({ task: "Trace startup flow across modules", root: "/repo" });
  const second = await adapter.context({ task: "Trace startup flow across apps", root: "/repo" });

  assert.deepEqual(calls.map((call) => call.name), ["codegraph_search", "codegraph_callers"]);
  assert.equal(first[0]?.metadata?.stage_cache_hits, 0);
  assert.equal(second[0]?.metadata?.stage_cache_hits, 2);
  assert.equal(second[0]?.metadata?.cache_hit, false);
  assert.equal(adapter.telemetry("/repo")?.stage_cache_hits, 2);

  await adapter.ensureIndexed("/repo", ["src/startup.ts"]);
  const third = await adapter.context({ task: "Trace startup flow across deps", root: "/repo" });
  assert.equal(calls.length, 4);
  assert.equal(third[0]?.metadata?.stage_cache_hits, 0);
});

test("prewarm indexes the project and warms the persistent CodeGraph MCP connection with status", async () => {
  const { adapter, calls } = createAdapter({ responses: { codegraph_status: "CodeGraph ready" } });

  await adapter.prewarm("/repo");
  await adapter.prewarm("/repo");

  assert.deepEqual(calls.map((call) => call.name), ["codegraph_status"]);
  assert.equal(calls[0]?.arguments.projectPath, "/repo");
  assert.ok(Number(adapter.telemetry("/repo")?.prewarm_ms) >= 0);
  assert.equal(adapter.telemetry("/repo")?.prewarm_cache_hit, true);
});

test("unchanged changed-file refresh receipts preserve hot evidence cache", async () => {
  let checks = 0;
  const { adapter, calls } = createAdapter({
    responses: { codegraph_search: "PromotionRepo location" },
    indexer: {
      async ensureIndexed(root) {
        checks += 1;
        return { ...receipt(root), synced: checks === 1 };
      }
    }
  });

  await adapter.ensureIndexed("/repo", ["core/src/PromotionRepo.java"]);
  const first = await adapter.context({ task: "Fix PromotionRepo", root: "/repo", changedFiles: ["core/src/PromotionRepo.java"] });
  await adapter.ensureIndexed("/repo", ["core/src/PromotionRepo.java"]);
  const second = await adapter.context({ task: "Fix PromotionRepo", root: "/repo", changedFiles: ["core/src/PromotionRepo.java"] });

  assert.equal(calls.length, 1);
  assert.equal(first[0]?.metadata?.cache_hit, false);
  assert.equal(second[0]?.metadata?.cache_hit, true);
});

test("skips repeated index checks while the workspace revision is unchanged", async () => {
  let generation = 0;
  let checks = 0;
  const { adapter } = createAdapter({
    rootRevision: () => ({ token: String(generation), cacheable: true }),
    indexer: {
      async ensureIndexed(root) {
        checks += 1;
        return receipt(root, `rev-${checks}`);
      }
    }
  });

  await adapter.ensureIndexed("/repo");
  await adapter.ensureIndexed("/repo");
  assert.equal(checks, 1);
  assert.equal(adapter.telemetry("/repo")?.index_cache_hit, true);

  generation += 1;
  await adapter.ensureIndexed("/repo");
  assert.equal(checks, 2);

  await adapter.ensureIndexed("/repo", ["src/a.ts"]);
  assert.equal(checks, 3);
});

test("coalesces concurrent index checks for the same workspace revision", async () => {
  let generation = 0;
  let checks = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { adapter } = createAdapter({
    rootRevision: () => ({ token: String(generation), cacheable: true }),
    indexer: {
      async ensureIndexed(root) {
        checks += 1;
        await gate;
        return receipt(root, "shared-revision");
      }
    }
  });

  const first = adapter.ensureIndexed("/repo", ["src/a.ts"]);
  const second = adapter.ensureIndexed("/repo");
  release();
  await Promise.all([first, second]);

  assert.equal(checks, 1);
  assert.equal(adapter.telemetry("/repo")?.index_cache_hit, true);
  assert.equal(adapter.telemetry("/repo")?.index_skip_reason, "inflight_join");
});

test("serializes a newer workspace revision behind an older in-flight index", async () => {
  let generation = 0;
  let checks = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { adapter } = createAdapter({
    rootRevision: () => ({ token: String(generation), cacheable: true }),
    indexer: {
      async ensureIndexed(root) {
        checks += 1;
        if (checks === 1) await gate;
        return receipt(root, `rev-${checks}`);
      }
    }
  });

  const first = adapter.ensureIndexed("/repo", ["src/a.ts"]);
  generation = 1;
  const second = adapter.ensureIndexed("/repo", ["src/b.ts"]);
  release();
  await Promise.all([first, second]);

  assert.equal(checks, 2);
  assert.equal(adapter.telemetry("/repo")?.index_cache_hit, false);
  assert.equal(adapter.telemetry("/repo")?.index_skip_reason, undefined);
});

test("skips CodeGraph sync for docs and runtime-only edits after initial indexing", async () => {
  let generation = 0;
  let checks = 0;
  const { adapter } = createAdapter({
    rootRevision: () => ({ token: String(generation), cacheable: true }),
    indexer: {
      async ensureIndexed(root) {
        checks += 1;
        return receipt(root, "stable-graph");
      }
    }
  });

  await adapter.ensureIndexed("/repo");
  generation += 1;
  await adapter.ensureIndexed("/repo", ["README.md", ".agent/state/current-task.json"]);
  assert.equal(checks, 1);
  assert.equal(adapter.telemetry("/repo")?.index_cache_hit, true);
  assert.equal(adapter.telemetry("/repo")?.index_skip_reason, "non_graph_changes");

  await adapter.ensureIndexed("/repo");
  assert.equal(checks, 1);
});

test("CodeGraph changed-file filter is conservative for source and config files", () => {
  assert.deepEqual(codeGraphRelevantChangedFiles([
    "README.md",
    "docs/architecture.png",
    "src/app.ts",
    "package.json",
    "config/custom.json"
  ]), ["src/app.ts", "package.json", "config/custom.json"]);
});

test("changed-file revision token stays stable until file metadata changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-codegraph-revision-"));
  const file = path.join(root, "a.ts");
  try {
    await writeFile(file, "export const a = 1;\n");
    const first = await changedFilesRevisionToken(root, [file]);
    const second = await changedFilesRevisionToken(root, ["a.ts"]);
    assert.equal(first, second);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(file, "export const a = 22;\n");
    const third = await changedFilesRevisionToken(root, [file]);
    assert.notEqual(first, third);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
