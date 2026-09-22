import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAstGrepArgs,
  createAstGrepSearch,
  inferPatternNodeKind,
  normalizeAstGrepMatch
} from "./ast-grep-search.mjs";

test("builds read-only ast-grep arguments and preserves ignore defaults", () => {
  const args = buildAstGrepArgs({
    pattern: "Promise.all($$$A)",
    lang: "ts",
    target: "src",
    glob: "*.ts"
  });
  assert.deepEqual(args, [
    "run",
    "--pattern", "Promise.all($$$A)",
    "--lang", "ts",
    "--debug-query=ast",
    "--json=stream",
    "--color", "never",
    "--globs", "*.ts",
    "src"
  ]);
  assert.equal(args.includes("--rewrite"), false);
  assert.equal(args.some((arg) => String(arg).startsWith("--no-ignore")), false);
});

test("normalizes ast-grep locations, node kind, text, and captures", () => {
  const result = normalizeAstGrepMatch({
    file: "src/a.ts",
    text: "const foo = bar();",
    range: {
      start: { line: 4, column: 2 },
      end: { line: 4, column: 20 }
    },
    metaVariables: {
      single: {
        A: {
          text: "foo",
          range: {
            start: { line: 4, column: 8 },
            end: { line: 4, column: 11 }
          }
        }
      },
      multi: {},
      transformed: {}
    }
  }, {
    cwd: "/repo",
    toRel: (value) => path.relative("/repo", value),
    nodeKind: "lexical_declaration"
  });

  assert.equal(result.path, "src/a.ts");
  assert.equal(result.line, 5);
  assert.equal(result.range.start.line, 5);
  assert.equal(result.node_kind, "lexical_declaration");
  assert.equal(result.captures.A.text, "foo");
  assert.equal(result.captures.A.range.start.line, 5);
});

test("infers the effective pattern node kind from ast-grep debug AST", () => {
  assert.equal(inferPatternNodeKind(
    "Debug AST:\nprogram (0,0)-(0,13)\n  lexical_declaration (0,0)-(0,13)\n    variable_declarator (0,6)-(0,13)\n\n"
  ), "lexical_declaration");
  assert.equal(inferPatternNodeKind(
    "Debug AST:\nprogram (0,0)-(0,10)\n  expression_statement (0,0)-(0,10)\n    call_expression (0,0)-(0,10)\n\n"
  ), "call_expression");
});

test("missing ast-grep binary returns a clean non-throwing result", async () => {
  const search = createAstGrepSearch({ binary: null, toRel: (value) => value });
  const result = await search.search({
    start: "/repo",
    pattern: "const $A = $B",
    lang: "ts"
  });
  assert.equal(result.ok, false);
  assert.equal(result.available, false);
  assert.equal(result.engine, "ast-grep");
  assert.deepEqual(result.matches, []);
});

test("scopes search to the requested file and bounds normalized matches", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-ast-grep-"));
  const file = path.join(dir, "src", "a.ts");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(file), { recursive: true }));
  await writeFile(file, "const a = 1;\n", "utf8");
  let invocation = null;
  const raw = {
    file: "a.ts",
    text: "const a = 1;",
    range: {
      start: { line: 0, column: 0 },
      end: { line: 0, column: 12 }
    },
    metaVariables: { single: {}, multi: {}, transformed: {} }
  };
  try {
    const search = createAstGrepSearch({
      binary: "ast-grep",
      toRel: (value) => path.relative(dir, value),
      runProcess: async (input) => {
        invocation = input;
        return {
          exit_code: 0,
          stopped_early: true,
          stderr: "Debug AST:\nprogram (0,0)-(0,12)\n  lexical_declaration (0,0)-(0,12)\n\n",
          matches: [raw, raw, raw]
        };
      }
    });
    const result = await search.search({
      start: file,
      pattern: "const $A = $B",
      lang: "ts",
      limit: 2
    });
    assert.equal(invocation.cwd, path.dirname(file));
    assert.equal(invocation.args.at(-1), "a.ts");
    assert.equal(result.count, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.matches[0].path, "src/a.ts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
