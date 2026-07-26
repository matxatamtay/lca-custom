// Local Coding Agent — reproducible patches for the pinned AgentMemory runtime
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import {
  createDeterministicSessionSummary,
  deterministicSummaryRuntimeSource
} from "./agentmemory-deterministic-summary.mjs";

export { createDeterministicSessionSummary };

export const ZERO_LLM_DETERMINISTIC_SUMMARY_PATCH_ID = "zero-llm-deterministic-summary-v3";
// Backward-compatible export used by the managed-runtime checks and older callers.
export const ZERO_LLM_SUMMARIZE_OTEL_PATCH_ID = ZERO_LLM_DETERMINISTIC_SUMMARY_PATCH_ID;

const PATCH_MARKER = `lca-patch:${ZERO_LLM_DETERMINISTIC_SUMMARY_PATCH_ID}`;
const PREVIOUS_PATCH_MARKERS = [
  "lca-patch:zero-llm-summarize-otel-v2",
  "lca-patch:zero-llm-summarize-otel-v1"
];
const TARGET_FILES = [
  path.join("dist", "index.mjs"),
  path.join("dist", "src-CzgoepGU.mjs")
];

const SUMMARIZE_SIGNATURE = "function registerSummarizeFunction(sdk, kv, provider, metricsStore) {";
const DETERMINISTIC_SUMMARY_SIGNATURE = "function createDeterministicSessionSummary(session, observations, now";
const EVENT_SIGNATURE = "function registerEventTriggers(sdk, kv) {";
const EVENT_SIGNATURE_V2 = "function registerEventTriggers(sdk, kv, provider) {";
const EVENT_CALL = "\tregisterEventTriggers(sdk, kv);";
const EVENT_CALL_V2 = "\tregisterEventTriggers(sdk, kv, provider);";
const EVENT_STOP_SIGNATURE = "\tsdk.registerFunction(\"event::session::stopped\", async (data) => {";
const NOOP_PROVIDER_CHECK = "(provider.name === \"noop\" || provider.name === \"resilient(noop)\")";
const DIRECT_SUMMARY_TRIGGER = [
  "\t\tconst summary = await sdk.trigger({",
  "\t\t\tfunction_id: \"mem::summarize\",",
  "\t\t\tpayload: data",
  "\t\t});"
].join("\n");

const DETERMINISTIC_HELPER_SOURCE = deterministicSummaryRuntimeSource(PATCH_MARKER);

const ZERO_LLM_SUMMARY_BRANCH = [
  `\t\tif (${NOOP_PROVIDER_CHECK}) {`,
  "\t\t\tconst summary = createDeterministicSessionSummary(session, compressed);",
  "\t\t\tconst summaryForValidation = {",
  "\t\t\t\ttitle: summary.title,",
  "\t\t\t\tnarrative: summary.narrative,",
  "\t\t\t\tkeyDecisions: summary.keyDecisions,",
  "\t\t\t\tfilesModified: summary.filesModified,",
  "\t\t\t\tconcepts: summary.concepts",
  "\t\t\t};",
  "\t\t\tconst validation = validateOutput(SummaryOutputSchema, summaryForValidation, \"mem::summarize\");",
  "\t\t\tif (!validation.valid) {",
  "\t\t\t\tlogger.warn(\"Deterministic summary validation failed\", { sessionId, errors: validation.result.errors });",
  "\t\t\t\treturn { success: false, error: \"validation_failed\", mode: \"deterministic\" };",
  "\t\t\t}",
  "\t\t\tconst qualityScore = scoreSummary(summaryForValidation);",
  "\t\t\tawait kv.set(KV.summaries, sessionId, summary);",
  "\t\t\tawait safeAudit(kv, \"compress\", \"mem::summarize\", [sessionId], {",
  "\t\t\t\ttitle: summary.title,",
  "\t\t\t\tobservationCount: compressed.length,",
  "\t\t\t\tmode: \"deterministic\"",
  "\t\t\t});",
  "\t\t\tconst latencyMs = Date.now() - startMs;",
  "\t\t\tif (metricsStore) await metricsStore.record(\"mem::summarize\", latencyMs, true, qualityScore);",
  "\t\t\tlogger.info(\"Session summarized deterministically\", { sessionId, title: summary.title, observationCount: compressed.length, qualityScore });",
  "\t\t\treturn { success: true, summary, qualityScore, mode: \"deterministic\" };",
  "\t\t}"
].join("\n");

export function agentMemoryPatchTargets(memoryDirectory) {
  const packageRoot = path.join(memoryDirectory, "node_modules", "@agentmemory", "agentmemory");
  return TARGET_FILES.map((relativePath) => path.join(packageRoot, relativePath));
}

export function inspectAgentMemoryRuntimePatches(memoryDirectory) {
  const targets = agentMemoryPatchTargets(memoryDirectory).map((file) => {
    if (!existsSync(file)) return { file, exists: false, patched: false, detail: "missing" };
    const content = readFileSync(file, "utf8");
    const patched = content.includes(PATCH_MARKER)
      && content.includes(DETERMINISTIC_SUMMARY_SIGNATURE)
      && content.includes(EVENT_SIGNATURE)
      && content.includes(EVENT_CALL)
      && content.includes(DIRECT_SUMMARY_TRIGGER)
      && content.includes("mode: \"deterministic\"")
      && countOccurrences(content, NOOP_PROVIDER_CHECK) === 1
      && PREVIOUS_PATCH_MARKERS.every((marker) => !content.includes(marker));
    return { file, exists: true, patched, detail: patched ? "patched" : "unpatched" };
  });
  const ok = targets.length > 0 && targets.every((target) => target.patched);
  return {
    ok,
    patchId: ZERO_LLM_DETERMINISTIC_SUMMARY_PATCH_ID,
    targets,
    detail: targets.map((target) => `${path.basename(target.file)}:${target.detail}`).join(", ")
  };
}

export function applyAgentMemoryRuntimePatches(memoryDirectory) {
  const results = agentMemoryPatchTargets(memoryDirectory).map((file) => patchTarget(file));
  return {
    patchId: ZERO_LLM_DETERMINISTIC_SUMMARY_PATCH_ID,
    changed: results.some((result) => result.changed),
    targets: results
  };
}

function patchTarget(file) {
  if (!existsSync(file)) throw new Error(`AgentMemory patch target is missing: ${file}`);
  const original = readFileSync(file, "utf8");
  if (original.includes(PATCH_MARKER)) {
    let repaired = normalizePreviousEventPatch(file, original);
    repaired = replaceZeroLlmSummaryBranch(file, repaired);
    assertPatchedLayout(file, repaired);
    if (repaired === original) return { file, changed: false };
    writeAtomic(file, repaired);
    return { file, changed: true };
  }

  let patched = normalizePreviousEventPatch(file, original);
  assertSingleOccurrence(file, patched, SUMMARIZE_SIGNATURE, "summarize function signature");
  if (patched.includes(DETERMINISTIC_SUMMARY_SIGNATURE)) {
    throw new Error(`AgentMemory deterministic summary helper exists without patch marker in ${file}`);
  }
  patched = patched.replace(SUMMARIZE_SIGNATURE, `${DETERMINISTIC_HELPER_SOURCE}\n${SUMMARIZE_SIGNATURE}`);
  patched = replaceZeroLlmSummaryBranch(file, patched);
  assertPatchedLayout(file, patched);
  writeAtomic(file, patched);
  return { file, changed: true };
}

function normalizePreviousEventPatch(file, content) {
  let normalized = content;
  if (normalized.includes(EVENT_SIGNATURE_V2)) {
    assertSingleOccurrence(file, normalized, EVENT_SIGNATURE_V2, "patched event trigger signature");
    normalized = normalized.replace(EVENT_SIGNATURE_V2, EVENT_SIGNATURE);
  }
  if (normalized.includes(EVENT_CALL_V2)) {
    assertSingleOccurrence(file, normalized, EVENT_CALL_V2, "patched event trigger registration");
    normalized = normalized.replace(EVENT_CALL_V2, EVENT_CALL);
  }

  const eventStart = normalized.indexOf(EVENT_STOP_SIGNATURE);
  if (eventStart === -1) throw new Error(`AgentMemory event::session::stopped layout mismatch in ${file}`);
  const summaryStart = normalized.indexOf("\t\tconst summary = ", eventStart);
  if (summaryStart === -1) throw new Error(`AgentMemory session-stop summarize layout mismatch in ${file}`);
  const reflectStart = normalized.indexOf("\n\t\tif (isReflectEnabled", summaryStart);
  const returnStart = normalized.indexOf("\n\t\treturn summary;", summaryStart);
  const summaryEnd = reflectStart !== -1 && (returnStart === -1 || reflectStart < returnStart) ? reflectStart : returnStart;
  if (summaryEnd === -1) throw new Error(`AgentMemory session-stop summarize terminator mismatch in ${file}`);

  let blockStart = summaryStart;
  const previousLineStart = normalized.lastIndexOf("\n", summaryStart - 2) + 1;
  const previousLine = normalized.slice(previousLineStart, summaryStart).trim();
  if (previousLine.includes("lca-patch:")) blockStart = previousLineStart;
  const currentBlock = normalized.slice(blockStart, summaryEnd).trimEnd();
  if (currentBlock !== DIRECT_SUMMARY_TRIGGER) {
    normalized = `${normalized.slice(0, blockStart)}${DIRECT_SUMMARY_TRIGGER}${normalized.slice(summaryEnd)}`;
  }
  return normalized;
}

function replaceZeroLlmSummaryBranch(file, content) {
  const functionStart = content.indexOf(SUMMARIZE_SIGNATURE);
  const providerCheck = content.indexOf("provider.name === \"noop\"", functionStart);
  const tryStart = content.indexOf("\n\t\ttry {", providerCheck);
  if (providerCheck === -1 || tryStart === -1) {
    throw new Error(`AgentMemory zero-LLM summarize branch layout mismatch in ${file}`);
  }
  const branchStart = content.lastIndexOf("\n", providerCheck) + 1;
  return `${content.slice(0, branchStart)}${ZERO_LLM_SUMMARY_BRANCH}${content.slice(tryStart)}`;
}

function assertPatchedLayout(file, content) {
  if (!content.includes(PATCH_MARKER)
    || !content.includes(DETERMINISTIC_SUMMARY_SIGNATURE)
    || !content.includes(EVENT_SIGNATURE)
    || !content.includes(EVENT_CALL)
    || content.includes(EVENT_SIGNATURE_V2)
    || content.includes(EVENT_CALL_V2)
    || !content.includes(DIRECT_SUMMARY_TRIGGER)
    || !content.includes("mode: \"deterministic\"")
    || countOccurrences(content, NOOP_PROVIDER_CHECK) !== 1
    || PREVIOUS_PATCH_MARKERS.some((marker) => content.includes(marker))) {
    throw new Error(`AgentMemory patch verification failed for ${file}`);
  }
}

function assertOccurrenceCount(file, content, needle, expected, label) {
  const count = countOccurrences(content, needle);
  if (count !== expected) {
    throw new Error(`AgentMemory ${label} layout mismatch in ${file} (expected ${expected} matches, found ${count})`);
  }
}

function assertSingleOccurrence(file, content, needle, label) {
  assertOccurrenceCount(file, content, needle, 1, label);
}

function countOccurrences(content, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function writeAtomic(file, content) {
  const mode = statSync(file).mode;
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, { encoding: "utf8", mode });
  renameSync(temp, file);
}
