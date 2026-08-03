// Local Coding Agent — shared workspace protocol tests
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceProtocol, buildResultDigest, matchesPathPattern, validateTaskDag } from "./workspace-protocol.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-protocol-"));
  let tick = 0;
  const protocol = new WorkspaceProtocol({
    primaryRoot: path.join(root, "workspace"),
    projectId: "project-123",
    stateDir: path.join(root, "state"),
    vaultDir: path.join(root, "vault"),
    now: () => `2026-07-18T00:00:0${tick++}.000Z`,
    uuid: () => `00000000-0000-4000-8000-${String(tick).padStart(12, "0")}`
  });
  await protocol.init();
  return { root, protocol };
}

test("writes Obsidian-compatible context with provenance", async () => {
  const { root, protocol } = await fixture();
  try {
    const pinned = await protocol.pinContext({
      key: "workflow.commit",
      value: "Do not commit unless explicitly requested.",
      scope: "global",
      source: "user",
      tags: ["workflow"],
      links: ["Tasks"]
    });
    const markdown = await readFile(pinned.path, "utf8");
    assert.match(markdown, /lca_type: "memory"/);
    assert.match(markdown, /source: "user"/);
    assert.match(markdown, /\[\[Tasks\]\]/);
    const listed = await protocol.listContext({ scope: "global", query: "commit" });
    assert.equal(listed.count, 1);
    const renamed = path.join(path.dirname(pinned.path), "Human Renamed Note.md");
    await rename(pinned.path, renamed);
    const explained = await protocol.explainContext({ key: "workflow.commit", scope: "global" });
    assert.equal(explained.path, renamed);
    assert.equal(explained.metadata.source, "user");
    assert.match(explained.value, /Do not commit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task brief, knowledge, intent checksum, and scope guard stay coherent", async () => {
  const { root, protocol } = await fixture();
  try {
    const task = await protocol.createTaskBrief({
      task_id: "w10-selectors",
      goal: "Implement selector matching",
      scope: ["crates/css"],
      out_of_scope: ["layout"],
      constraints: ["No large dependency"],
      definition_of_done: ["Tests pass"],
      scope_guard: { allowed_paths: ["crates/css/**", "docs/**"], denied_paths: ["server/package-lock.json"] }
    });
    await protocol.knowledgeState({ action: "add", task_id: task.task_id, type: "assumption", text: ":has is out of scope", source: "assistant" });
    const intent = await protocol.intentCheck({ task_id: task.task_id, expected_files: ["crates/css/src/selectors.rs"] });
    assert.equal(intent.task_id, "w10-selectors");
    assert.match(intent.intent_checksum, /^[a-f0-9]{16}$/);
    assert.deepEqual(intent.assumptions, [":has is out of scope"]);
    await protocol.assertPathsAllowed(task.task_id, ["crates/css/src/selectors.rs", "docs/w10.md"]);
    await assert.rejects(() => protocol.assertPathsAllowed(task.task_id, ["server/package-lock.json"]), /Scope guard denied/);
    await assert.rejects(() => protocol.assertPathsAllowed(task.task_id, ["README.md"]), /does not allow/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates DAG dependencies and cycles", () => {
  assert.deepEqual(validateTaskDag([
    { id: "parser", depends_on: [] },
    { id: "matcher", depends_on: ["parser"] }
  ]).ids, ["parser", "matcher"]);
  assert.throws(() => validateTaskDag([{ id: "a", depends_on: ["missing"] }]), /unknown task/);
  assert.throws(() => validateTaskDag([
    { id: "a", depends_on: ["b"] },
    { id: "b", depends_on: ["a"] }
  ]), /dependency cycle/);
});

test("builds compact command result digests", () => {
  const digest = buildResultDigest({ ok: false, exitCode: 3, stdout: "96 passed\n4 failed", stderr: "nth parser failed" });
  assert.equal(digest.ok, false);
  assert.ok(digest.facts.includes("96 passed"));
  assert.ok(digest.facts.includes("4 failed"));
  assert.ok(digest.blockers.includes("nth parser failed"));
});

test("matches exact directories and glob patterns", () => {
  assert.equal(matchesPathPattern("crates/css/src/lib.rs", "crates/css"), true);
  assert.equal(matchesPathPattern("crates/css/src/lib.rs", "crates/**"), true);
  assert.equal(matchesPathPattern("server/server.mjs", "crates/**"), false);
});
