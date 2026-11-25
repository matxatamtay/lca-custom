import assert from "node:assert/strict";
import test from "node:test";

import { createFsWriteToolRegistrar, planReplacementBatch } from "./fs-write-tools.mjs";

function makeHarness({ patchOk = true } = {}) {
  const tools = new Map();
  let verificationCalls = 0;
  let postEditCalls = 0;
  const traceNames = [];
  const registrar = createFsWriteToolRegistrar({
    reg(_mcp, name, def, handler) { tools.set(name, { def, handler }); },
    jsonResult(value) { return value; },
    resolvePath(value) { return value.startsWith("/") ? value : `/repo/${value}`; },
    toRel(value) { return value.replace(/^\/repo\//, ""); },
    applyOperations: async () => [{ ok: patchOk, path: "src/a.ts", ...(patchOk ? {} : { conflict: "no match" }) }],
    applyUnifiedDiff: async () => [{ ok: patchOk, path: "src/a.ts", ...(patchOk ? {} : { conflict: "no match" }) }],
    createBackupBatch: async () => null,
    runJournaledMutation: async (_tool, _paths, operation) => operation(),
    editTransaction: { async run(_paths, operation) { return operation({ preState: new Map() }); } },
    postEditIntelligence: {
      async analyze(paths) {
        postEditCalls += 1;
        return { changed_files: paths.map((path) => ({ path })), summary: { files: paths.length } };
      }
    },
    workspaceStateRegistry: null,
    projectRootForPath: () => "/repo",
    resolveActiveProjectRoot: async () => ({ root: "/repo" }),
    changeAwareVerification: {
      async execute(root, files, options) {
        verificationCalls += 1;
        return { ok: true, root, changed_files: files, options, gates: [{ name: "typecheck" }], failed: 0 };
      }
    },
    async traceSpan(name, operation) {
      traceNames.push(name);
      return operation();
    }
  });
  registrar({});
  return {
    tools,
    get verificationCalls() { return verificationCalls; },
    get postEditCalls() { return postEditCalls; },
    traceNames
  };
}

test("plans ordered same-file replacement batches in one read/write transaction", () => {
  const planned = planReplacementBatch("const a = 1;\nconst b = a + 1;\n", [
    { old_text: "const a = 1;", new_text: "const a = 2;" },
    { old_text: "const b = a + 1;", new_text: "const b = a + 2;" }
  ]);
  assert.equal(planned.edits, 2);
  assert.equal(planned.replacements, 2);
  assert.equal(planned.content, "const a = 2;\nconst b = a + 2;\n");
  assert.deepEqual(planned.match_strategies, ["exact", "exact"]);
});

test("replace_in_file exposes replacements[] for same-file batching", () => {
  const harness = makeHarness();
  const tool = harness.tools.get("replace_in_file");
  assert.ok(tool?.def?.inputSchema?.replacements);
});

test("apply_patch exposes opt-in changed verification and runs it after a successful patch", async () => {
  const harness = makeHarness();
  const tool = harness.tools.get("apply_patch");
  assert.ok(tool?.def?.inputSchema?.verify, "apply_patch schema should expose verify");

  const result = await tool.handler({
    operations: [{ op: "update", path: "src/a.ts", edits: [{ old_text: "a", new_text: "b" }] }],
    verify: "changed"
  });

  assert.equal(result.ok, true);
  assert.equal(harness.postEditCalls, 1);
  assert.equal(harness.verificationCalls, 1);
  assert.equal(result.verification.requested, true);
  assert.equal(result.verification.ok, true);
  assert.equal(result.verification.roots[0].root, "/repo");
  assert.deepEqual(result.verification.roots[0].files, ["/repo/src/a.ts"]);
  assert.deepEqual(harness.traceNames, [
    "workspace_edit.match",
    "workspace_edit.write",
    "workspace_edit.semantic_refresh",
    "workspace_edit.verify_changed"
  ]);
});

test("apply_patch keeps default behavior unchanged and never verifies a failed patch", async () => {
  const defaultHarness = makeHarness();
  const defaultResult = await defaultHarness.tools.get("apply_patch").handler({
    operations: [{ op: "create", path: "src/a.ts", content: "a" }]
  });
  assert.equal(defaultResult.ok, true);
  assert.equal(defaultHarness.verificationCalls, 0);
  assert.equal(defaultHarness.postEditCalls, 1);

  const failedHarness = makeHarness({ patchOk: false });
  const failedResult = await failedHarness.tools.get("apply_patch").handler({
    operations: [{ op: "update", path: "src/a.ts", edits: [{ old_text: "missing", new_text: "b" }] }],
    verify: "changed"
  });
  assert.equal(failedResult.ok, false);
  assert.equal(failedHarness.verificationCalls, 0);
  assert.equal(failedHarness.postEditCalls, 0);
  assert.equal("verification" in failedResult, false);
});
