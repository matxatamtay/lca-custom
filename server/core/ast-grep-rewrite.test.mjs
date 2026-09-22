import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyAstRewritePlanToBuffer,
  buildAstGrepRewriteArgs,
  createAstGrepRewritePlanner,
  validateRewriteMatches
} from "./ast-grep-rewrite.mjs";

test("rewrite CLI invocation is preview-only and never enables ast-grep source mutation", () => {
  const args = buildAstGrepRewriteArgs({
    pattern: "const $A = $B",
    rewrite: "let $A = $B",
    lang: "ts",
    target: "src"
  });
  assert.deepEqual(args, [
    "run",
    "--pattern", "const $A = $B",
    "--rewrite", "let $A = $B",
    "--lang", "ts",
    "--debug-query=ast",
    "--json=stream",
    "--color", "never",
    "src"
  ]);
  assert.equal(args.includes("--update-all"), false);
  assert.equal(args.includes("--interactive"), false);
});

test("applies non-overlapping byte-range rewrites in descending order", () => {
  const raw = Buffer.from("const a = 1;\nconst b = 2;\n", "utf8");
  const result = applyAstRewritePlanToBuffer(raw, [
    { offsets: { start: 0, end: 12 }, text: "const a = 1;", replacement: "let a = 1;" },
    { offsets: { start: 13, end: 25 }, text: "const b = 2;", replacement: "let b = 2;" }
  ], "sample.ts");
  assert.equal(result.toString("utf8"), "let a = 1;\nlet b = 2;\n");
});

test("rejects overlapping and stale rewrite plans before writing", () => {
  const raw = Buffer.from("const a = 1;\n", "utf8");
  assert.throws(() => validateRewriteMatches(raw, [
    { offsets: { start: 0, end: 7 }, text: "const a", replacement: "let a" },
    { offsets: { start: 4, end: 12 }, text: "t a = 1;", replacement: "x" }
  ], "sample.ts"), /Overlapping/);
  assert.throws(() => validateRewriteMatches(raw, [
    { offsets: { start: 0, end: 12 }, text: "const b = 1;", replacement: "let b = 1;" }
  ], "sample.ts"), /STALE_AST_MATCH/);
});

test("planner enforces explicit match limits, deduplicates nested scopes, and hashes the preimage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-ast-rewrite-"));
  const src = path.join(root, "src");
  const file = path.join(src, "a.ts");
  await mkdir(src, { recursive: true });
  await writeFile(file, "const a = 1;\n", "utf8");
  const invocations = [];
  try {
    const planner = createAstGrepRewritePlanner({
      binary: "ast-grep",
      toRel: (value) => path.relative(root, value),
      runProcess: async (input) => {
        invocations.push(input);
        return {
          exit_code: 0,
          stopped_early: false,
          stderr: "Debug AST:\nprogram (0,0)-(0,12)\n  lexical_declaration (0,0)-(0,12)\n\n",
          matches: [{
            file: "a.ts",
            text: "const a = 1;",
            replacement: "let a = 1;",
            replacementOffsets: { start: 0, end: 12 },
            range: {
              byteOffset: { start: 0, end: 12 },
              start: { line: 0, column: 0 },
              end: { line: 0, column: 12 }
            },
            metaVariables: { single: {}, multi: {}, transformed: {} }
          }]
        };
      }
    });
    const plan = await planner.plan({
      pattern: "const $A = $B",
      rewrite: "let $A = $B",
      lang: "ts",
      paths: [src, file],
      maxMatches: 2
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.count, 1);
    assert.equal(plan.files.length, 1);
    assert.equal(plan.files[0].path, "src/a.ts");
    assert.match(plan.files[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(invocations.length, 1, "nested file scope should be covered by its parent directory scope");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planner refuses overflow rather than partially applying a repo-wide codemod", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-ast-rewrite-limit-"));
  const file = path.join(root, "a.ts");
  await writeFile(file, "const a = 1;\nconst b = 2;\n", "utf8");
  try {
    const planner = createAstGrepRewritePlanner({
      binary: "ast-grep",
      toRel: (value) => path.relative(root, value),
      runProcess: async () => ({
        exit_code: 0,
        stopped_early: true,
        stderr: "",
        matches: [
          {
            file: "a.ts",
            text: "const a = 1;",
            replacement: "let a = 1;",
            replacementOffsets: { start: 0, end: 12 },
            range: { start: { line: 0, column: 0 }, end: { line: 0, column: 12 } },
            metaVariables: {}
          },
          {
            file: "a.ts",
            text: "const b = 2;",
            replacement: "let b = 2;",
            replacementOffsets: { start: 13, end: 25 },
            range: { start: { line: 1, column: 0 }, end: { line: 1, column: 12 } },
            metaVariables: {}
          }
        ]
      })
    });
    const plan = await planner.plan({
      pattern: "const $A = $B",
      rewrite: "let $A = $B",
      lang: "ts",
      paths: [root],
      maxMatches: 1
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, "match_limit_exceeded");
    assert.equal(plan.overflow, true);
    assert.equal(plan.matches.length, 1);
    assert.equal((await readFile(file, "utf8")).startsWith("const"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
