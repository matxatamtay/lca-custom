import test from "node:test";
import assert from "node:assert/strict";

import {
  RevisionAwareFilesystemContextPort,
  RevisionAwareSemanticContextPort,
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
  assert.equal(first[0]?.metadata?.cache_hit, undefined);
  assert.equal(second[0]?.metadata?.cache_hit, true);

  revisions.bump("/repo");
  const third = await cached.search(request);
  assert.equal(calls, 2);
  assert.equal(third[0]?.id, "hit-2");
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
  assert.equal(second.evidence[0]?.metadata?.cache_layer, "root-revision");

  cached.invalidate("/repo");
  revisions.bump("/repo");
  const third = await cached.context(request);
  assert.equal(calls, 2);
  assert.equal(third.evidence[0]?.id, "semantic-2");
  assert.equal(first.evidence[0]?.id, "semantic-1");
});
