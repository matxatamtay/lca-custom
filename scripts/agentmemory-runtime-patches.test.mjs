import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyAgentMemoryRuntimePatches,
  inspectAgentMemoryRuntimePatches,
  ZERO_LLM_SUMMARIZE_OTEL_PATCH_ID
} from "./agentmemory-runtime-patches.mjs";

function createRuntimeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "lca-agentmemory-patch-"));
  const packageRoot = path.join(root, "node_modules", "@agentmemory", "agentmemory");
  const dist = path.join(packageRoot, "dist");
  mkdirSync(dist, { recursive: true });
  const source = [
    "function registerEventTriggers(sdk, kv) {",
    "\tsdk.registerFunction(\"event::session::stopped\", async (data) => {",
    "\t\tconst summary = await sdk.trigger({",
    "\t\t\tfunction_id: \"mem::summarize\",",
    "\t\t\tpayload: data",
    "\t\t});",
    "\t\treturn summary;",
    "\t});",
    "}",
    "\tregisterEventTriggers(sdk, kv);",
    ""
  ].join("\n");
  for (const name of ["index.mjs", "src-CzgoepGU.mjs"]) {
    writeFileSync(path.join(dist, name), source);
  }
  return { root, dist };
}

test("patches zero-LLM session stop without changing explicit summarize behavior", () => {
  const { root, dist } = createRuntimeFixture();
  try {
    const before = inspectAgentMemoryRuntimePatches(root);
    assert.equal(before.ok, false);

    const result = applyAgentMemoryRuntimePatches(root);
    assert.equal(result.patchId, ZERO_LLM_SUMMARIZE_OTEL_PATCH_ID);
    assert.equal(result.changed, true);

    const content = readFileSync(path.join(dist, "index.mjs"), "utf8");
    assert.match(content, /function registerEventTriggers\(sdk, kv, provider\)/);
    assert.match(content, /provider\.name === "noop"/);
    assert.match(content, /success: true/);
    assert.match(content, /skipped: true/);
    assert.match(content, /reason: "no_provider"/);
    assert.match(content, /registerEventTriggers\(sdk, kv, provider\)/);
    assert.match(content, /function_id: "mem::summarize"/);
    assert.equal(inspectAgentMemoryRuntimePatches(root).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patch application is idempotent", () => {
  const { root } = createRuntimeFixture();
  try {
    assert.equal(applyAgentMemoryRuntimePatches(root).changed, true);
    assert.equal(applyAgentMemoryRuntimePatches(root).changed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when the pinned AgentMemory layout changes", () => {
  const { root, dist } = createRuntimeFixture();
  try {
    writeFileSync(path.join(dist, "index.mjs"), "export {};\n");
    assert.throws(
      () => applyAgentMemoryRuntimePatches(root),
      /layout mismatch/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
