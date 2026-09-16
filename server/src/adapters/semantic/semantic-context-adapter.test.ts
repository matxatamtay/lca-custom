import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SemanticContextAdapter, detectSemanticLanguage, type SemanticEngine } from "./semantic-context-adapter.js";

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-semantic-detect-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("detects TypeScript, Dart, and Java project markers", async () => {
  await withTempDir(async (root) => {
    await writeFile(path.join(root, "tsconfig.json"), "{}\n", "utf8");
    assert.equal(await detectSemanticLanguage(root), "typescript");
  });
  await withTempDir(async (root) => {
    await writeFile(path.join(root, "pubspec.yaml"), "name: demo\n", "utf8");
    assert.equal(await detectSemanticLanguage(root), "dart");
  });
  await withTempDir(async (root) => {
    await writeFile(path.join(root, "pom.xml"), "<project/>\n", "utf8");
    assert.equal(await detectSemanticLanguage(root), "java");
  });
});

test("changed files select the active language before root markers", async () => {
  await withTempDir(async (root) => {
    await writeFile(path.join(root, "pubspec.yaml"), "name: demo\n", "utf8");
    assert.equal(await detectSemanticLanguage(root, ["src/AdminUserRepo.java"]), "java");
    assert.equal(await detectSemanticLanguage(root, ["lib/main.dart"]), "dart");
    assert.equal(await detectSemanticLanguage(root, ["src/index.ts"]), "typescript");
  });
});

test("reports an explicit unavailable capability when no engine is registered", async () => {
  await withTempDir(async (root) => {
    await writeFile(path.join(root, "pom.xml"), "<project/>\n", "utf8");
    const adapter = new SemanticContextAdapter([]);
    const result = await adapter.context({ task: "Trace AdminUserRepo", root });

    assert.equal(result.language, "java");
    assert.equal(result.available, false);
    assert.equal(result.engine, null);
    assert.match(result.reason ?? "", /not registered/);
  });
});

test("routes a supported language to its registered semantic engine", async () => {
  await withTempDir(async (root) => {
    await writeFile(path.join(root, "pubspec.yaml"), "name: demo\n", "utf8");
    const engine: SemanticEngine = {
      language: "dart",
      name: "fake-dart",
      async context() {
        return [{
          id: "dart-hit",
          provider: "semantic",
          kind: "symbol",
          title: "Dart symbol",
          content: "DemoController",
          score: 90
        }];
      }
    };
    const adapter = new SemanticContextAdapter([engine]);
    const result = await adapter.context({ task: "Find DemoController", root });

    assert.equal(result.available, true);
    assert.equal(result.engine, "fake-dart");
    assert.equal(result.evidence.length, 1);
  });
});
