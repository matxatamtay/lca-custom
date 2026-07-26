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

function originalRuntimeSource() {
  return [
    "function registerSummarizeFunction(sdk, kv, provider, metricsStore) {",
    "\tsdk.registerFunction(\"mem::summarize\", async (data) => {",
    "\t\tif (provider.name === \"noop\") return { success: false, error: \"no_provider\" };",
    "\t});",
    "}",
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
}

function createRuntimeFixture(source = originalRuntimeSource()) {
  const root = mkdtempSync(path.join(os.tmpdir(), "lca-agentmemory-patch-"));
  const packageRoot = path.join(root, "node_modules", "@agentmemory", "agentmemory");
  const dist = path.join(packageRoot, "dist");
  mkdirSync(dist, { recursive: true });
  for (const name of ["index.mjs", "src-CzgoepGU.mjs"]) {
    writeFileSync(path.join(dist, name), source);
  }
  return { root, dist };
}

test("recognizes wrapped zero-LLM providers in explicit and automatic summarize paths", () => {
  const { root, dist } = createRuntimeFixture();
  try {
    const before = inspectAgentMemoryRuntimePatches(root);
    assert.equal(before.ok, false);

    const result = applyAgentMemoryRuntimePatches(root);
    assert.equal(result.patchId, ZERO_LLM_SUMMARIZE_OTEL_PATCH_ID);
    assert.equal(result.changed, true);

    const content = readFileSync(path.join(dist, "index.mjs"), "utf8");
    assert.match(content, /function registerEventTriggers\(sdk, kv, provider\)/);
    assert.equal((content.match(/resilient\(noop\)/g) ?? []).length, 2);
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

test("migrates the v1 patch that missed ResilientProvider wrappers", () => {
  const v1 = originalRuntimeSource()
    .replace("function registerEventTriggers(sdk, kv) {", "function registerEventTriggers(sdk, kv, provider) {")
    .replace([
      "\t\tconst summary = await sdk.trigger({",
      "\t\t\tfunction_id: \"mem::summarize\",",
      "\t\t\tpayload: data",
      "\t\t});"
    ].join("\n"), [
      "\t\t// lca-patch:zero-llm-summarize-otel-v1: zero-LLM is an intentional mode, not a failed function call.",
      "\t\tconst summary = provider.name === \"noop\" ? {",
      "\t\t\tsuccess: true,",
      "\t\t\tskipped: true,",
      "\t\t\treason: \"no_provider\"",
      "\t\t} : await sdk.trigger({",
      "\t\t\tfunction_id: \"mem::summarize\",",
      "\t\t\tpayload: data",
      "\t\t});"
    ].join("\n"))
    .replace("\tregisterEventTriggers(sdk, kv);", "\tregisterEventTriggers(sdk, kv, provider);");
  const { root, dist } = createRuntimeFixture(v1);
  try {
    assert.equal(applyAgentMemoryRuntimePatches(root).changed, true);
    const content = readFileSync(path.join(dist, "index.mjs"), "utf8");
    assert.match(content, /zero-llm-summarize-otel-v2/);
    assert.doesNotMatch(content, /zero-llm-summarize-otel-v1/);
    assert.equal((content.match(/resilient\(noop\)/g) ?? []).length, 2);
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
