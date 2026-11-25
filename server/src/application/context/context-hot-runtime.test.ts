import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  RevisionAwareFilesystemContextPort,
  RevisionAwareSemanticContextPort,
  WorkspaceRevisionTracker,
  shouldIgnoreRevisionEvent,
  type RootRevisionSource
} from "./context-hot-runtime.js";
import type { ContextEvidence } from "../../domain/task-context.js";

function fakeRevisionSource(): RootRevisionSource & { generation: number } {
  return {
    generation: 0,
    revision() { return { token: String(this.generation), cacheable: true }; },
    bump() { this.generation += 1; }
  };
}

function evidence(id: string): ContextEvidence {
  return { id, provider: "filesystem", kind: "text", title: id, content: id };
}

test("filesystem hot cache reuses only while the root revision is unchanged", async () => {
  const revisions = fakeRevisionSource();
  let calls = 0;
  const cached = new RevisionAwareFilesystemContextPort({
    async search() {
      calls += 1;
      return [evidence(`hit-${calls}`)];
    }
  }, revisions);
  const request = { task: "fix banner", root: "/repo" };

  const first = await cached.search(request);
  const second = await cached.search(request);
  assert.equal(calls, 1);
  assert.equal(first[0]?.metadata?.cache_hit, false);
  assert.equal(second[0]?.metadata?.cache_hit, true);

  revisions.bump("/repo");
  const third = await cached.search(request);
  assert.equal(calls, 2);
  assert.equal(third[0]?.id, "hit-2");
});

test("filesystem hot cache joins identical in-flight searches", async () => {
  const revisions = fakeRevisionSource();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const cached = new RevisionAwareFilesystemContextPort({
    async search() {
      calls += 1;
      await gate;
      return [evidence("shared")];
    }
  }, revisions);
  const request = { task: "trace startup", root: "/repo" };

  const first = cached.search(request);
  const second = cached.search(request);
  release();
  const [left, right] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(left[0]?.metadata?.cache_hit, false);
  assert.equal(right[0]?.metadata?.cache_hit, true);
  assert.equal(right[0]?.metadata?.cache_layer, "root-revision-inflight");
});

test("cache key normalizes task whitespace and changed-file ordering but respects budgets", async () => {
  const revisions = fakeRevisionSource();
  let calls = 0;
  const cached = new RevisionAwareFilesystemContextPort({
    async search() {
      calls += 1;
      return [evidence(`result-${calls}`)];
    }
  }, revisions);

  const first = await cached.search({
    task: "trace   startup",
    root: "/repo",
    changedFiles: ["b.ts", "a.ts"],
    budget: { maxItems: 10, maxChars: 10_000 }
  });
  const second = await cached.search({
    task: "trace startup",
    root: "/repo",
    changedFiles: ["a.ts", "b.ts"],
    budget: { maxItems: 10, maxChars: 10_000 }
  });
  const third = await cached.search({
    task: "trace startup",
    root: "/repo",
    changedFiles: ["a.ts", "b.ts"],
    budget: { maxItems: 11, maxChars: 10_000 }
  });

  assert.equal(calls, 2);
  assert.equal(first[0]?.metadata?.cache_hit, false);
  assert.equal(second[0]?.metadata?.cache_hit, true);
  assert.equal(third[0]?.metadata?.cache_hit, false);
});

test("revision changes during an in-flight search cannot poison the new revision cache", async () => {
  const revisions = fakeRevisionSource();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const cached = new RevisionAwareFilesystemContextPort({
    async search() {
      calls += 1;
      const callNumber = calls;
      if (callNumber === 1) await gate;
      return [evidence(callNumber === 1 ? "stale-old-revision" : "fresh-new-revision")];
    }
  }, revisions);
  const request = { task: "trace startup", root: "/repo" };

  const oldRequest = cached.search(request);
  revisions.bump("/repo");
  const freshRequest = cached.search(request);
  release();
  const [oldResult, freshResult] = await Promise.all([oldRequest, freshRequest]);
  const repeatedFresh = await cached.search(request);

  assert.equal(calls, 2);
  assert.equal(oldResult[0]?.id, "stale-old-revision");
  assert.equal(freshResult[0]?.id, "fresh-new-revision");
  assert.equal(repeatedFresh[0]?.id, "fresh-new-revision");
  assert.equal(repeatedFresh[0]?.metadata?.cache_hit, true);
});

test("uncacheable revision sources always query the live provider", async () => {
  let calls = 0;
  const cached = new RevisionAwareFilesystemContextPort({
    async search() { calls += 1; return []; }
  }, {
    revision() { return { token: "0", cacheable: false }; },
    bump() {}
  });

  await cached.search({ task: "one", root: "/repo" });
  await cached.search({ task: "one", root: "/repo" });
  assert.equal(calls, 2);
});

test("semantic hot cache preserves capability metadata and invalidates by revision", async () => {
  const revisions = fakeRevisionSource();
  let calls = 0;
  const cached = new RevisionAwareSemanticContextPort({
    async context() {
      calls += 1;
      return {
        evidence: [{ ...evidence(`semantic-${calls}`), provider: "semantic" as const }],
        language: "typescript" as const,
        engine: "test-engine",
        available: true,
        state: "ready" as const
      };
    }
  }, revisions);

  const request = { task: "trace startup", root: "/repo" };
  const first = await cached.context(request);
  const second = await cached.context(request);
  assert.equal(calls, 1);
  assert.equal(second.language, "typescript");
  assert.equal(first.evidence[0]?.metadata?.cache_hit, false);
  assert.equal(second.evidence[0]?.metadata?.cache_layer, "root-revision");

  cached.invalidate("/repo");
  revisions.bump("/repo");
  const third = await cached.context(request);
  assert.equal(calls, 2);
  assert.equal(third.evidence[0]?.id, "semantic-2");
  assert.equal(first.evidence[0]?.id, "semantic-1");
});

test("workspace revision ignores generated dependency and graph churn", () => {
  assert.equal(shouldIgnoreRevisionEvent(".codegraph/codegraph.db-wal"), true);
  assert.equal(shouldIgnoreRevisionEvent(".git/index.lock"), true);
  assert.equal(shouldIgnoreRevisionEvent("node_modules/pkg/index.js"), true);
  assert.equal(shouldIgnoreRevisionEvent(".agent"), true);
  assert.equal(shouldIgnoreRevisionEvent(".agent/state/current-task.json"), true);
  assert.equal(shouldIgnoreRevisionEvent("runtime/agentmemory/runtime.json"), true);
  assert.equal(shouldIgnoreRevisionEvent("src/application/context.ts"), false);
  assert.equal(shouldIgnoreRevisionEvent("package.json"), false);
  assert.equal(shouldIgnoreRevisionEvent(null), false);
});

test("real workspace watcher ignores runtime churn but detects source changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-context-revision-"));
  await mkdir(path.join(root, ".agent", "state"), { recursive: true });
  await mkdir(path.join(root, "data", "workspaces", "x"), { recursive: true });
  const tracker = new WorkspaceRevisionTracker({
    ignore: (_root, filename) => {
      const normalized = String(filename ?? "").replaceAll("\\", "/");
      return normalized === "data" || normalized.startsWith("data/");
    }
  });
  try {
    const initial = tracker.revision(root).token;
    await writeFile(path.join(root, ".agent", "state", "task.json"), "{}");
    await writeFile(path.join(root, "data", "workspaces", "x", "telemetry.json"), "{}");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(tracker.revision(root).token, initial);

    await writeFile(path.join(root, "source.ts"), "export const changed = true;\n");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.notEqual(tracker.revision(root).token, initial);
  } finally {
    tracker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("manual changed-file bumps coalesce their matching fs.watch event without hiding unrelated edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-context-manual-bump-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  const file = path.join(root, "src", "probe.ts");
  await writeFile(file, "export const probe = 1;\n");
  const tracker = new WorkspaceRevisionTracker();
  try {
    tracker.revision(root);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const initial = Number(tracker.revision(root).token);

    // Exercise both orderings: watcher-first, then manual bump.
    await writeFile(file, "export const probe = 2;\n");
    await new Promise((resolve) => setTimeout(resolve, 40));
    tracker.bump(root, [file]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(Number(tracker.revision(root).token), initial + 1);

    // And manual-bump-first while the matching watcher event is still pending.
    await writeFile(file, "export const probe = 3;\n");
    tracker.bump(root, [file]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(Number(tracker.revision(root).token), initial + 2);

    // A different file in the same directory must still invalidate the root.
    await writeFile(path.join(root, "src", "external.ts"), "export const external = true;\n");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(Number(tracker.revision(root).token), initial + 3);
  } finally {
    tracker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("root-specific ignores do not globally hide ordinary data paths", () => {
  const serverRoot = "/repo/server";
  const ignore = (root: string, filename: string | Buffer | null) => {
    const normalized = String(filename ?? "").replaceAll("\\", "/");
    return root === serverRoot && (normalized === "data" || normalized.startsWith("data/"));
  };
  assert.equal(ignore(serverRoot, "data"), true);
  assert.equal(ignore(serverRoot, "data/workspaces/events.jsonl"), true);
  assert.equal(ignore("/repo/other", "data/source.json"), false);
  assert.equal(shouldIgnoreRevisionEvent("data/source.json"), false);
});
