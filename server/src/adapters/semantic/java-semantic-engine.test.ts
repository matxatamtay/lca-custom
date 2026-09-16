import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JavaSemanticEngine, javaReadiness, resolveJdtLsExecutable } from "./java-semantic-engine.js";
import type { SemanticEngineResult } from "./semantic-context-adapter.js";

function semanticResult(value: Awaited<ReturnType<JavaSemanticEngine["context"]>>): SemanticEngineResult {
  assert.ok(!Array.isArray(value));
  return value as SemanticEngineResult;
}

test("Java semantic engine reports unavailable instead of fabricating evidence when JDT LS is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-java-semantic-"));
  const engine = new JavaSemanticEngine({ resolveJdtLsExecutable: async () => null });
  try {
    const result = semanticResult(await engine.context({ task: "Trace PromotionRepo callers", root }));
    assert.equal(result.state, "unavailable");
    assert.equal(result.evidence.length, 0);
    assert.match(result.reason ?? "", /JDT Language Server was not found/);
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("JDT LS resolver discovers the newest LCA-managed runtime without system installation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-jdt-managed-"));
  const managed = path.join(root, "runtime", "jdtls");
  const executable = process.platform === "win32" ? "jdtls.bat" : "jdtls";
  const older = path.join(managed, "1.60.0", "bin", executable);
  const newer = path.join(managed, "1.61.0", "bin", executable);
  try {
    await mkdir(path.dirname(older), { recursive: true });
    await mkdir(path.dirname(newer), { recursive: true });
    await writeFile(older, "old", "utf8");
    await writeFile(newer, "new", "utf8");
    const result = await resolveJdtLsExecutable(root, { PATH: "" }, path.join(root, "empty-home"), managed);
    assert.equal(result, newer);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JDT LS resolver does not discover unrelated Java binaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-jdt-resolve-"));
  try {
    const result = await resolveJdtLsExecutable(
      root,
      { PATH: "" },
      path.join(root, "empty-home"),
      path.join(root, "empty-managed")
    );
    assert.equal(result, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Java readiness ignores source downloads after the semantic index can be usable", () => {
  assert.equal(javaReadiness("language/status", { type: "Starting", message: "Importing Maven project" }), "warming");
  assert.equal(javaReadiness("language/status", { type: "Started", message: "Ready" }), "ready");
  assert.equal(javaReadiness("language/status", { type: "ServiceReady", message: "ServiceReady" }), "ready");
  assert.equal(javaReadiness("$/progress", {
    value: { kind: "report", message: "Download sources and javadoc: twa-commons-cache - 15%" }
  }), undefined);
  assert.equal(javaReadiness("$/progress", {
    value: { kind: "report", message: "Searching... - 80% 100 files to index" }
  }), "warming");
  assert.equal(javaReadiness("$/progress", {
    value: { kind: "end", message: "Searching..." }
  }), "ready");
});
