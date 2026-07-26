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

export const ZERO_LLM_SUMMARIZE_OTEL_PATCH_ID = "zero-llm-summarize-otel-v1";

const PATCH_MARKER = `lca-patch:${ZERO_LLM_SUMMARIZE_OTEL_PATCH_ID}`;
const TARGET_FILES = [
  path.join("dist", "index.mjs"),
  path.join("dist", "src-CzgoepGU.mjs")
];

const EVENT_SIGNATURE_BEFORE = "function registerEventTriggers(sdk, kv) {";
const EVENT_SIGNATURE_AFTER = "function registerEventTriggers(sdk, kv, provider) {";
const EVENT_CALL_BEFORE = "\tregisterEventTriggers(sdk, kv);";
const EVENT_CALL_AFTER = "\tregisterEventTriggers(sdk, kv, provider);";
const SUMMARY_TRIGGER_BEFORE = [
  "\t\tconst summary = await sdk.trigger({",
  "\t\t\tfunction_id: \"mem::summarize\",",
  "\t\t\tpayload: data",
  "\t\t});"
].join("\n");
const SUMMARY_TRIGGER_AFTER = [
  `\t\t// ${PATCH_MARKER}: zero-LLM is an intentional mode, not a failed function call.`,
  "\t\tconst summary = provider.name === \"noop\" ? {",
  "\t\t\tsuccess: true,",
  "\t\t\tskipped: true,",
  "\t\t\treason: \"no_provider\"",
  "\t\t} : await sdk.trigger({",
  "\t\t\tfunction_id: \"mem::summarize\",",
  "\t\t\tpayload: data",
  "\t\t});"
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
      && content.includes(EVENT_SIGNATURE_AFTER)
      && content.includes(EVENT_CALL_AFTER);
    return { file, exists: true, patched, detail: patched ? "patched" : "unpatched" };
  });
  const ok = targets.length > 0 && targets.every((target) => target.patched);
  return {
    ok,
    patchId: ZERO_LLM_SUMMARIZE_OTEL_PATCH_ID,
    targets,
    detail: targets.map((target) => `${path.basename(target.file)}:${target.detail}`).join(", ")
  };
}

export function applyAgentMemoryRuntimePatches(memoryDirectory) {
  const results = agentMemoryPatchTargets(memoryDirectory).map((file) => patchTarget(file));
  return {
    patchId: ZERO_LLM_SUMMARIZE_OTEL_PATCH_ID,
    changed: results.some((result) => result.changed),
    targets: results
  };
}

function patchTarget(file) {
  if (!existsSync(file)) throw new Error(`AgentMemory patch target is missing: ${file}`);
  const original = readFileSync(file, "utf8");
  if (original.includes(PATCH_MARKER)) {
    assertPatchedLayout(file, original);
    return { file, changed: false };
  }

  assertSingleOccurrence(file, original, EVENT_SIGNATURE_BEFORE, "event trigger signature");
  assertSingleOccurrence(file, original, SUMMARY_TRIGGER_BEFORE, "session-stop summarize trigger");
  assertSingleOccurrence(file, original, EVENT_CALL_BEFORE, "event trigger registration");

  const patched = original
    .replace(EVENT_SIGNATURE_BEFORE, EVENT_SIGNATURE_AFTER)
    .replace(SUMMARY_TRIGGER_BEFORE, SUMMARY_TRIGGER_AFTER)
    .replace(EVENT_CALL_BEFORE, EVENT_CALL_AFTER);
  assertPatchedLayout(file, patched);
  writeAtomic(file, patched);
  return { file, changed: true };
}

function assertPatchedLayout(file, content) {
  if (!content.includes(PATCH_MARKER)
    || !content.includes(EVENT_SIGNATURE_AFTER)
    || !content.includes(EVENT_CALL_AFTER)) {
    throw new Error(`AgentMemory patch verification failed for ${file}`);
  }
}

function assertSingleOccurrence(file, content, needle, label) {
  const first = content.indexOf(needle);
  const second = first === -1 ? -1 : content.indexOf(needle, first + needle.length);
  if (first === -1 || second !== -1) {
    const count = first === -1 ? 0 : 2;
    throw new Error(`AgentMemory ${label} layout mismatch in ${file} (expected exactly one match, found ${count}${second !== -1 ? "+" : ""})`);
  }
}

function writeAtomic(file, content) {
  const mode = statSync(file).mode;
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, { encoding: "utf8", mode });
  renameSync(temp, file);
}
