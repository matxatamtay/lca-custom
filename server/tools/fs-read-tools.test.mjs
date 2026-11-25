import assert from "node:assert/strict";
import test from "node:test";

import { createFsReadToolRegistrar } from "./fs-read-tools.mjs";

function makeHarness() {
  const tools = new Map();
  const astCalls = [];
  const registrar = createFsReadToolRegistrar({
    reg(_mcp, name, def, handler) { tools.set(name, { def, handler }); },
    jsonResult(value) { return value; },
    resolvePath(value) { return value.startsWith("/") ? value : `/repo/${value}`; },
    toRel(value) { return value.replace(/^\/repo\//, ""); },
    listEntries: async () => [],
    ripgrepGrep: async () => [],
    gitGrep: async () => [],
    attachContext: async () => {},
    findFiles: async () => ({ engine: "scan", files: [] }),
    searchTree: async () => [],
    buildTree: async () => ({ tree: [], dirs: [], files: [] }),
    astGrepSearch: {
      async search(input) {
        astCalls.push(input);
        return { ok: true, engine: "ast-grep", available: true, count: 0, matches: [] };
      }
    },
    RG_BIN: null,
    MANIFEST_NAMES: new Set(),
    MAX_BATCH_READ_CHARS: 100_000,
    MAX_READ_CHARS: 100_000,
    READ_DEFAULT: 10_000
  });
  registrar({});
  return { tools, astCalls };
}

test("ast_search is read-only, scoped, and routed through the existing search registrar", async () => {
  const harness = makeHarness();
  const tool = harness.tools.get("ast_search");
  assert.ok(tool);
  assert.ok(tool.def.inputSchema.pattern);
  assert.ok(tool.def.inputSchema.lang);
  assert.equal(tool.def.inputSchema.rewrite, undefined);

  const result = await tool.handler({
    pattern: "Promise.all($$$A)",
    lang: "ts",
    path: "src",
    glob: "*.ts",
    limit: 25
  });

  assert.equal(result.engine, "ast-grep");
  assert.deepEqual(harness.astCalls, [{
    start: "/repo/src",
    pattern: "Promise.all($$$A)",
    lang: "ts",
    glob: "*.ts",
    limit: 25
  }]);
});
