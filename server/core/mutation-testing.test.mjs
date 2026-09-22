import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildStrykerArgs,
  buildTestQualityCandidates,
  createMutationTestingRunner,
  formatMutationRange,
  isMutationEligible,
  parseMutationReport,
  resolveStrykerBinary,
  survivingMutantToCandidate
} from "./mutation-testing.mjs";

test("Stryker changed mode is incremental, scoped, and forced without npx auto-install", () => {
  const args = buildStrykerArgs({
    incrementalFile: "/state/stryker-incremental.json",
    mode: "changed",
    targets: ["src/a.ts", "src/b.js"]
  });
  assert.deepEqual(args, [
    "run",
    "--incremental",
    "--incrementalFile", "/state/stryker-incremental.json",
    "--allowConsoleColors", "false",
    "--force",
    "--mutate", "src/a.ts,src/b.js"
  ]);
  assert.equal(args.includes("npx"), false);
});

test("exact mutation range uses Stryker file:start-end syntax", () => {
  assert.equal(formatMutationRange("src/foo.ts", { start_line: 73, end_line: 74 }), "src/foo.ts:73-74");
  assert.throws(() => formatMutationRange("src/foo.ts", { start_line: 9, end_line: 8 }), /Invalid mutation range/);
});

test("eligible mutation files exclude tests, declarations, output, and non-JS/TS", () => {
  assert.equal(isMutationEligible("/repo/src/a.ts"), true);
  assert.equal(isMutationEligible("/repo/src/a.mjs"), true);
  assert.equal(isMutationEligible("/repo/src/a.test.ts"), false);
  assert.equal(isMutationEligible("/repo/src/a.spec.js"), false);
  assert.equal(isMutationEligible("/repo/src/a.d.ts"), false);
  assert.equal(isMutationEligible("/repo/__tests__/a.ts"), false);
  assert.equal(isMutationEligible("/repo/dist/a.js"), false);
  assert.equal(isMutationEligible("/repo/src/a.dart"), false);
});

test("local project Stryker binary is preferred and missing binary is clean", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-stryker-bin-"));
  try {
    const binDir = path.join(root, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });
    const bin = path.join(binDir, process.platform === "win32" ? "stryker.cmd" : "stryker");
    await writeFile(bin, "", "utf8");
    assert.equal(resolveStrykerBinary(root), bin);
    assert.equal(resolveStrykerBinary(path.join(root, "nested")), bin);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(resolveStrykerBinary("/definitely/missing", { hasCommand: () => false }), null);
});

test("mutation report computes detected/undetected score and bounded survivors", () => {
  const parsed = parseMutationReport({
    schemaVersion: "2.0",
    files: {
      "src/a.ts": {
        source: "secret source must not be returned",
        mutants: [
          { id: "1", mutatorName: "EqualityOperator", replacement: "!==", status: "Killed", location: loc(1) },
          { id: "2", mutatorName: "LogicalOperator", replacement: "||", status: "Survived", location: loc(2) },
          { id: "3", mutatorName: "BooleanLiteral", replacement: "false", status: "NoCoverage", location: loc(3) },
          { id: "4", mutatorName: "ConditionalExpression", replacement: "true", status: "Timeout", location: loc(4) }
        ]
      }
    }
  }, { root: "/repo", maxSurvivors: 10 });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.telemetry, {
    mutants_total: 4,
    killed: 1,
    survived: 1,
    timeout: 1,
    no_coverage: 1,
    mutation_score: 50,
    compile_error: 0,
    runtime_error: 0,
    ignored: 0,
    pending: 0
  });
  assert.equal(parsed.surviving_mutants.length, 1);
  assert.equal(parsed.surviving_mutants[0].path, "src/a.ts");
  assert.doesNotMatch(JSON.stringify(parsed), /secret source/);
});

test("surviving mutant becomes TEST_QUALITY candidate without source payload", () => {
  const candidate = survivingMutantToCandidate({
    path: "src/a.ts",
    id: "12",
    mutator: "EqualityOperator",
    replacement: "!==",
    location: loc(4)
  });
  assert.equal(candidate.category, "TEST_QUALITY");
  assert.deepEqual(candidate.source, ["stryker"]);
  assert.deepEqual(candidate.affected_paths, ["src/a.ts"]);
  assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(candidate.evidence.rerun, {
    action: "mutation",
    mode: "module",
    module: "src/a.ts",
    range: { start_line: 4, end_line: 4 }
  });
});

test("Phase 8 prioritizes mutation candidates by survivor count x change frequency x blast radius", () => {
  const candidates = buildTestQualityCandidates([
    { path: "src/hot.ts", id: "1", mutator: "A", replacement: "x", location: loc(4) },
    { path: "src/hot.ts", id: "2", mutator: "B", replacement: "y", location: loc(5) },
    { path: "src/cold.ts", id: "3", mutator: "C", replacement: "z", location: loc(6) }
  ], {
    "src/hot.ts": {
      source_change_frequency: 8,
      blast_radius: 4,
      related_tests: ["src/hot.test.ts"],
      reference_files: ["src/consumer.ts"]
    },
    "src/cold.ts": {
      source_change_frequency: 1,
      blast_radius: 1,
      related_tests: []
    }
  }, 67);
  const hot = candidates.find((candidate) => candidate.evidence.mutant_id === "1");
  const cold = candidates.find((candidate) => candidate.evidence.mutant_id === "3");
  assert.equal(hot.evidence.survived_mutant_count, 2);
  assert.equal(hot.evidence.priority_signal, 64);
  assert.equal(cold.evidence.priority_signal, 1);
  assert.ok(hot.impact > cold.impact);
  assert.deepEqual(hot.evidence.related_tests, ["src/hot.test.ts"]);
  assert.deepEqual(hot.evidence.reference_files, ["src/consumer.ts"]);
  assert.equal(hot.baseline.mutation_score, 67);
});

test("runner ingests surviving mutants and ordinary changed code does not block on score", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-mutation-runner-"));
  const stateDir = path.join(root, ".state");
  const src = path.join(root, "src");
  const binDir = path.join(root, "node_modules", ".bin");
  await mkdir(src, { recursive: true });
  await mkdir(binDir, { recursive: true });
  const binary = path.join(binDir, process.platform === "win32" ? "stryker.cmd" : "stryker");
  await writeFile(binary, "", "utf8");
  await writeFile(path.join(src, "a.ts"), "export const a = true;\n", "utf8");
  const ingested = [];
  try {
    const runner = createMutationTestingRunner({
      spawnCapture: async (command, args) => {
        if (command === "git") {
          return { exit_code: 0, stdout: args[0] === "diff" && !args.includes("--cached") ? "src/a.ts\n" : "", duration_ms: 1 };
        }
        const incrementalFile = args[args.indexOf("--incrementalFile") + 1];
        await mkdir(path.dirname(incrementalFile), { recursive: true });
        await writeFile(incrementalFile, JSON.stringify(reportWithStatuses(["Killed", "Survived"])), "utf8");
        return { exit_code: 0, stdout: "", stderr: "", duration_ms: 123, timed_out: false };
      },
      stateDirForRoot: async () => stateDir,
      ingestCandidates: async (_root, candidates) => {
        ingested.push(...candidates);
        return { detected: candidates.length, added: candidates.length, existing: 0, total: candidates.length };
      }
    });
    const result = await runner.run({ root, mode: "changed", threshold: 99, criticalPaths: [] });
    assert.equal(result.available, true);
    assert.equal(result.ok, true);
    assert.equal(result.gate, "warn");
    assert.equal(result.telemetry.mutation_score, 50);
    assert.equal(result.telemetry.survived, 1);
    assert.equal(result.critical_gate.enabled, false);
    assert.equal(ingested.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit critical changed paths may block below caller threshold", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-mutation-critical-"));
  const stateDir = path.join(root, ".state");
  const src = path.join(root, "src", "critical");
  const binDir = path.join(root, "node_modules", ".bin");
  await mkdir(src, { recursive: true });
  await mkdir(binDir, { recursive: true });
  const binary = path.join(binDir, process.platform === "win32" ? "stryker.cmd" : "stryker");
  await writeFile(binary, "", "utf8");
  await writeFile(path.join(src, "core.ts"), "export const core = true;\n", "utf8");
  try {
    const runner = createMutationTestingRunner({
      spawnCapture: async (command, args) => {
        if (command === "git") {
          return { exit_code: 0, stdout: args[0] === "diff" && !args.includes("--cached") ? "src/critical/core.ts\n" : "", duration_ms: 1 };
        }
        const incrementalFile = args[args.indexOf("--incrementalFile") + 1];
        await mkdir(path.dirname(incrementalFile), { recursive: true });
        await writeFile(incrementalFile, JSON.stringify(reportWithStatuses(["Killed", "Survived"])), "utf8");
        return { exit_code: 0, stdout: "", stderr: "", duration_ms: 50, timed_out: false };
      },
      stateDirForRoot: async () => stateDir
    });
    const result = await runner.run({
      root,
      mode: "changed",
      threshold: 80,
      criticalPaths: ["src/critical/**"]
    });
    assert.equal(result.ok, false);
    assert.equal(result.gate, "fail");
    assert.equal(result.reason, "mutation_threshold");
    assert.equal(result.critical_gate.enabled, true);
    assert.equal(result.critical_gate.threshold, 80);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing local Stryker binary returns structured optional-sensor result", async () => {
  const runner = createMutationTestingRunner({
    spawnCapture: async () => { throw new Error("should not execute"); },
    stateDirForRoot: async () => "/tmp",
    hasCommand: () => false
  });
  const result = await runner.run({ root: "/definitely/missing", mode: "changed" });
  assert.equal(result.available, false);
  assert.equal(result.gate, "unavailable");
  assert.equal(result.reason, "stryker_cli_unavailable");
});

function reportWithStatuses(statuses) {
  return {
    schemaVersion: "2.0",
    thresholds: { high: 80, low: 60 },
    files: {
      "src/a.ts": {
        language: "typescript",
        source: "export const a = true;",
        mutants: statuses.map((status, index) => ({
          id: String(index + 1),
          mutatorName: "BooleanLiteral",
          replacement: "false",
          status,
          location: loc(index + 1)
        }))
      }
    }
  };
}

function loc(line) {
  return {
    start: { line, column: 1 },
    end: { line, column: 2 }
  };
}
