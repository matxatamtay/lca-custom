import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyAgentMemoryRuntimePatches,
  createDeterministicSessionSummary,
  inspectAgentMemoryRuntimePatches,
  ZERO_LLM_DETERMINISTIC_SUMMARY_PATCH_ID,
  ZERO_LLM_SUMMARIZE_OTEL_PATCH_ID
} from "./agentmemory-runtime-patches.mjs";

const DIRECT_SUMMARY_TRIGGER = [
  "\t\tconst summary = await sdk.trigger({",
  "\t\t\tfunction_id: \"mem::summarize\",",
  "\t\t\tpayload: data",
  "\t\t});"
].join("\n");

function originalRuntimeSource() {
  return [
    "function registerSummarizeFunction(sdk, kv, provider, metricsStore) {",
    "\tsdk.registerFunction(\"mem::summarize\", async (data) => {",
    "\t\tconst startMs = Date.now();",
    "\t\tconst sessionId = data.sessionId.trim();",
    "\t\tconst session = await kv.get(KV.sessions, sessionId);",
    "\t\tconst compressed = (await kv.list(KV.observations(sessionId))).filter((o) => o.title);",
    "\t\tif (provider.name === \"noop\") {",
    "\t\t\treturn { success: false, error: \"no_provider\" };",
    "\t\t}",
    "\t\ttry {",
    "\t\t\treturn { success: true };",
    "\t\t} catch (error) {",
    "\t\t\treturn { success: false, error: String(error) };",
    "\t\t}",
    "\t});",
    "}",
    "function registerEventTriggers(sdk, kv) {",
    "\tsdk.registerFunction(\"event::session::stopped\", async (data) => {",
    DIRECT_SUMMARY_TRIGGER,
    "\t\tif (isReflectEnabled()) {}",
    "\t\treturn summary;",
    "\t});",
    "}",
    "\tregisterEventTriggers(sdk, kv);",
    ""
  ].join("\n");
}

function previousPatchedSource(version) {
  const wrapped = version === 2;
  const marker = `lca-patch:zero-llm-summarize-otel-v${version}`;
  return originalRuntimeSource()
    .replace("provider.name === \"noop\"", wrapped
      ? "(provider.name === \"noop\" || provider.name === \"resilient(noop)\")"
      : "provider.name === \"noop\"")
    .replace("function registerEventTriggers(sdk, kv) {", "function registerEventTriggers(sdk, kv, provider) {")
    .replace(DIRECT_SUMMARY_TRIGGER, [
      `\t\t// ${marker}: zero-LLM is an intentional mode, not a failed function call.`,
      `\t\tconst summary = ${wrapped
        ? "(provider.name === \"noop\" || provider.name === \"resilient(noop)\")"
        : "provider.name === \"noop\""} ? {`,
      "\t\t\tsuccess: true,",
      "\t\t\tskipped: true,",
      "\t\t\treason: \"no_provider\"",
      "\t\t} : await sdk.trigger({",
      "\t\t\tfunction_id: \"mem::summarize\",",
      "\t\t\tpayload: data",
      "\t\t});"
    ].join("\n"))
    .replace("\tregisterEventTriggers(sdk, kv);", "\tregisterEventTriggers(sdk, kv, provider);");
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

test("builds a useful deterministic summary from compressed LCA observations", () => {
  const summary = createDeterministicSessionSummary({
    id: "lca-123-test",
    project: "demo-project",
    startedAt: "2026-07-26T10:00:00.000Z",
    endedAt: "2026-07-26T10:05:00.000Z"
  }, [
    {
      title: "workspace_context",
      type: "other",
      narrative: "{\"task\":\"Fix zero-LLM memory summaries\",\"path\":\"/repo/demo\",\"changed_files\":[\"scripts/runtime.mjs\"]} | Context ready",
      concepts: ["agentmemory"],
      files: []
    },
    {
      title: "workspace_edit",
      type: "file_edit",
      narrative: "{\"path\":\"/repo/demo/scripts/runtime.mjs\"} | success",
      files: ["scripts/runtime.test.mjs"]
    },
    {
      title: "workspace_exec",
      type: "error",
      narrative: "{\"cwd\":\"/repo/demo\"} | failed; exit_code=1",
      files: []
    }
  ], () => new Date("2026-07-26T10:05:01.000Z"));

  assert.equal(summary.mode, "deterministic");
  assert.equal(summary.title, "Fix zero-LLM memory summaries");
  assert.equal(summary.observationCount, 3);
  assert.match(summary.narrative, /workspace_context:1/);
  assert.match(summary.narrative, /Failures detected: 1/);
  assert.deepEqual(new Set(summary.filesModified), new Set([
    "/repo/demo",
    "scripts/runtime.mjs",
    "/repo/demo/scripts/runtime.mjs",
    "scripts/runtime.test.mjs"
  ]));
  assert.ok(summary.concepts.includes("agentmemory"));
  assert.ok(summary.concepts.includes("deterministic-summary"));
});

test("patches explicit and automatic summarize paths for deterministic zero-LLM summaries", () => {
  const { root, dist } = createRuntimeFixture();
  try {
    assert.equal(inspectAgentMemoryRuntimePatches(root).ok, false);

    const result = applyAgentMemoryRuntimePatches(root);
    assert.equal(result.patchId, ZERO_LLM_DETERMINISTIC_SUMMARY_PATCH_ID);
    assert.equal(ZERO_LLM_SUMMARIZE_OTEL_PATCH_ID, ZERO_LLM_DETERMINISTIC_SUMMARY_PATCH_ID);
    assert.equal(result.changed, true);

    const content = readFileSync(path.join(dist, "index.mjs"), "utf8");
    assert.match(content, /zero-llm-deterministic-summary-v3/);
    assert.match(content, /function createDeterministicSessionSummary/);
    assert.match(content, /Session summarized deterministically/);
    assert.match(content, /metricsStore\.record\("mem::summarize", latencyMs, true, qualityScore\)/);
    assert.match(content, /mode: "deterministic"/);
    assert.match(content, /function registerEventTriggers\(sdk, kv\)/);
    assert.doesNotMatch(content, /registerEventTriggers\(sdk, kv, provider\)/);
    assert.match(content, /const summary = await sdk\.trigger\(\{/);
    assert.doesNotMatch(content, /skipped: true/);
    assert.equal(inspectAgentMemoryRuntimePatches(root).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const version of [1, 2]) {
  test(`migrates the v${version} telemetry patch to deterministic summaries`, () => {
    const { root, dist } = createRuntimeFixture(previousPatchedSource(version));
    try {
      assert.equal(applyAgentMemoryRuntimePatches(root).changed, true);
      const content = readFileSync(path.join(dist, "index.mjs"), "utf8");
      assert.match(content, /zero-llm-deterministic-summary-v3/);
      assert.doesNotMatch(content, /zero-llm-summarize-otel-v[12]/);
      assert.doesNotMatch(content, /skipped: true/);
      assert.match(content, /function registerEventTriggers\(sdk, kv\)/);
      assert.match(content, /provider\.name === "resilient\(noop\)"/);
      assert.equal(inspectAgentMemoryRuntimePatches(root).ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("repairs a v3 runtime contaminated by an older in-memory v2 patcher", () => {
  const { root, dist } = createRuntimeFixture();
  try {
    assert.equal(applyAgentMemoryRuntimePatches(root).changed, true);
    const canonical = readFileSync(path.join(dist, "index.mjs"), "utf8");
    const contaminated = canonical
      .replace(
        "if ((provider.name === \"noop\" || provider.name === \"resilient(noop)\")) {",
        "if (((provider.name === \"noop\" || provider.name === \"resilient(noop)\") || provider.name === \"resilient(noop)\")) {"
      )
      .replace("function registerEventTriggers(sdk, kv) {", "function registerEventTriggers(sdk, kv, provider) {")
      .replace(DIRECT_SUMMARY_TRIGGER, [
        "\t\t// lca-patch:zero-llm-summarize-otel-v2: zero-LLM is an intentional mode, not a failed function call.",
        "\t\tconst summary = (provider.name === \"noop\" || provider.name === \"resilient(noop)\") ? {",
        "\t\t\tsuccess: true,",
        "\t\t\tskipped: true,",
        "\t\t\treason: \"no_provider\"",
        "\t\t} : await sdk.trigger({",
        "\t\t\tfunction_id: \"mem::summarize\",",
        "\t\t\tpayload: data",
        "\t\t});"
      ].join("\n"))
      .replace("\tregisterEventTriggers(sdk, kv);", "\tregisterEventTriggers(sdk, kv, provider);");
    for (const name of ["index.mjs", "src-CzgoepGU.mjs"]) {
      writeFileSync(path.join(dist, name), contaminated);
    }

    assert.equal(inspectAgentMemoryRuntimePatches(root).ok, false);
    assert.equal(applyAgentMemoryRuntimePatches(root).changed, true);
    const repaired = readFileSync(path.join(dist, "index.mjs"), "utf8");
    assert.doesNotMatch(repaired, /zero-llm-summarize-otel-v2/);
    assert.doesNotMatch(repaired, /skipped: true/);
    assert.match(repaired, /if \(\(provider\.name === \"noop\" \|\| provider\.name === \"resilient\(noop\)\"\)\) \{/);
    assert.doesNotMatch(repaired, /if \(\(\(/);
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
