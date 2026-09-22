import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSemgrepArgs,
  collectSemgrepRuleConfigs,
  createSemgrepScanner,
  normalizeSemgrepOutput,
  warningFindingToCandidate
} from "./semgrep-scan.mjs";

test("Semgrep invocation is local/offline and never requests registry policy", () => {
  const args = buildSemgrepArgs({
    configs: ["/rules/a.yml", "/rules/b.yml"],
    targets: ["src"]
  });
  assert.deepEqual(args, [
    "scan",
    "--config", "/rules/a.yml",
    "--config", "/rules/b.yml",
    "--json",
    "--metrics=off",
    "--disable-version-check",
    "--quiet",
    "src"
  ]);
  assert.equal(args.some((arg) => /auto|registry|policy/i.test(String(arg))), false);
  assert.equal(args.includes("--error"), false);
});

test("discovers rule packs recursively in deterministic order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-semgrep-rules-"));
  try {
    await mkdir(path.join(root, "security"), { recursive: true });
    await mkdir(path.join(root, "correctness"), { recursive: true });
    await writeFile(path.join(root, "security", "b.yaml"), "rules: []\n");
    await writeFile(path.join(root, "correctness", "a.yml"), "rules: []\n");
    await writeFile(path.join(root, "README.md"), "ignored\n");
    const configs = await collectSemgrepRuleConfigs(root);
    assert.deepEqual(configs.map((value) => path.relative(root, value)), [
      path.join("correctness", "a.yml"),
      path.join("security", "b.yaml")
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes findings without persisting matched source text", () => {
  const normalized = normalizeSemgrepOutput({
    results: [
      {
        check_id: "lca.security.example",
        path: "src/a.ts",
        start: { line: 4, col: 2 },
        end: { line: 4, col: 9 },
        extra: {
          severity: "ERROR",
          message: "unsafe",
          lines: "SECRET_SHOULD_NOT_LEAK",
          metadata: { lca_category: "SECURITY", component: "privacy" }
        }
      },
      {
        check_id: "lca.health.example",
        path: "src/b.ts",
        start: { line: 8, col: 1 },
        end: { line: 8, col: 3 },
        extra: { severity: "INFO", message: "observe" }
      }
    ]
  }, {
    root: "/repo",
    toRel: (value) => path.relative("/repo", value),
    maxResults: 10
  });
  assert.equal(normalized.summary.error, 1);
  assert.equal(normalized.summary.info, 1);
  assert.equal(normalized.findings[0].path, "src/a.ts");
  assert.equal(JSON.stringify(normalized), JSON.stringify(normalized).replace(/SECRET_SHOULD_NOT_LEAK/g, ""));
});

test("result bounding never hides ERROR severity from the gate summary", () => {
  const normalized = normalizeSemgrepOutput({
    results: [
      {
        check_id: "info-first",
        path: "src/a.ts",
        start: { line: 1, col: 1 },
        end: { line: 1, col: 2 },
        extra: { severity: "INFO", message: "first" }
      },
      {
        check_id: "error-after-limit",
        path: "src/b.ts",
        start: { line: 2, col: 1 },
        end: { line: 2, col: 2 },
        extra: { severity: "ERROR", message: "must still block" }
      }
    ]
  }, {
    root: "/repo",
    toRel: (value) => path.relative("/repo", value),
    maxResults: 1
  });
  assert.equal(normalized.findings.length, 1);
  assert.equal(normalized.summary.truncated, true);
  assert.equal(normalized.summary.error, 1);
  assert.equal(normalized.summary.info, 1);
});

test("WARNING becomes one canonical improvement candidate", () => {
  const candidate = warningFindingToCandidate({
    rule_id: "lca.regression.duplicate-observer",
    path: "core/a.mjs",
    line: 10,
    column: 2,
    severity: "WARNING",
    message: "duplicate observer",
    metadata: { lca_category: "RELIABILITY", component: "performance-follow" }
  });
  assert.equal(candidate.category, "RELIABILITY");
  assert.equal(candidate.component, "performance-follow");
  assert.deepEqual(candidate.source, ["semgrep"]);
  assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);
});

test("scanner maps ERROR to gate failure, WARNING to candidate, INFO to telemetry only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-semgrep-scan-"));
  const rulesDir = path.join(root, "rules");
  await mkdir(rulesDir, { recursive: true });
  await writeFile(path.join(rulesDir, "rules.yml"), "rules: []\n");
  const ingested = [];
  try {
    const scanner = createSemgrepScanner({
      binary: "semgrep",
      rulesDir,
      toRel: (value) => path.relative(root, value),
      spawnCapture: async () => ({
        exit_code: 0,
        timed_out: false,
        stderr: "",
        stdout: JSON.stringify({
          results: [
            {
              check_id: "error-rule",
              path: "src/a.ts",
              start: { line: 1, col: 1 },
              end: { line: 1, col: 2 },
              extra: { severity: "ERROR", message: "block", metadata: { lca_category: "CORRECTNESS" } }
            },
            {
              check_id: "warning-rule",
              path: "src/b.ts",
              start: { line: 2, col: 1 },
              end: { line: 2, col: 2 },
              extra: { severity: "WARNING", message: "candidate", metadata: { lca_category: "CODE_HEALTH" } }
            },
            {
              check_id: "info-rule",
              path: "src/c.ts",
              start: { line: 3, col: 1 },
              end: { line: 3, col: 2 },
              extra: { severity: "INFO", message: "telemetry" }
            }
          ],
          errors: []
        })
      }),
      recordCandidates: async (_scanRoot, candidates) => {
        ingested.push(...candidates);
        return { detected: candidates.length, added: candidates.length, existing: 0, total: candidates.length };
      }
    });

    const result = await scanner.scan({ root, maxResults: 20 });
    assert.equal(result.available, true);
    assert.equal(result.ok, false);
    assert.equal(result.gate, "fail");
    assert.deepEqual(result.summary, { findings: 3, returned: 3, truncated: false, error: 1, warning: 1, info: 1 });
    assert.equal(ingested.length, 1);
    assert.equal(ingested[0].evidence.rule_id, "warning-rule");
    assert.equal(result.candidate_ingestion.added, 1);
    assert.equal(result.telemetry.info_findings, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("learned rule lifecycle maps shadow to INFO, validated to WARNING, and blocking to declared severity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-semgrep-lifecycle-"));
  const rulesDir = path.join(root, "rules");
  await mkdir(rulesDir, { recursive: true });
  await writeFile(path.join(rulesDir, "static.yml"), "rules: []\n");
  const learned = path.join(root, "learned.yml");
  await writeFile(learned, "rules: []\n");
  const ingested = [];
  const observations = [];
  try {
    const scanner = createSemgrepScanner({
      binary: "semgrep",
      rulesDir,
      additionalRuleConfigs: async () => [learned],
      recordRuleScan: async (_scanRoot, observation) => {
        observations.push(observation);
        return { recorded: observation.complete, rules: 3 };
      },
      recordCandidates: async (_scanRoot, candidates) => {
        ingested.push(...candidates);
        return { detected: candidates.length, added: candidates.length, existing: 0, total: candidates.length };
      },
      toRel: (value) => path.relative(root, value),
      spawnCapture: async () => ({
        exit_code: 0,
        timed_out: false,
        stdout: JSON.stringify({
          results: [
            {
              check_id: "lca.learned.shadow",
              path: "a.ts",
              start: { line: 1, col: 1 },
              end: { line: 1, col: 2 },
              extra: { severity: "ERROR", message: "shadow", metadata: { lca_rule_state: "shadow", lca_declared_severity: "ERROR" } }
            },
            {
              check_id: "lca.learned.validated",
              path: "b.ts",
              start: { line: 2, col: 1 },
              end: { line: 2, col: 2 },
              extra: { severity: "ERROR", message: "validated", metadata: { lca_rule_state: "validated", lca_declared_severity: "ERROR" } }
            },
            {
              check_id: "lca.learned.blocking",
              path: "c.ts",
              start: { line: 3, col: 1 },
              end: { line: 3, col: 2 },
              extra: { severity: "ERROR", message: "blocking", metadata: { lca_rule_state: "blocking", lca_declared_severity: "ERROR" } }
            }
          ],
          errors: []
        })
      })
    });
    const result = await scanner.scan({ root });
    assert.equal(result.summary.info, 1);
    assert.equal(result.summary.warning, 1);
    assert.equal(result.summary.error, 1);
    assert.equal(result.ok, false);
    assert.equal(ingested.length, 1);
    assert.equal(ingested[0].evidence.rule_id, "lca.learned.validated");
    assert.equal(observations.length, 1);
    assert.equal(observations[0].complete, true);
    assert.deepEqual(new Set(observations[0].matchedRuleIds), new Set([
      "lca.learned.shadow",
      "lca.learned.validated",
      "lca.learned.blocking"
    ]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing Semgrep CLI is a structured optional-sensor result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-semgrep-missing-"));
  const rulesDir = path.join(root, "rules");
  await mkdir(rulesDir, { recursive: true });
  await writeFile(path.join(rulesDir, "rules.yml"), "rules: []\n");
  try {
    const scanner = createSemgrepScanner({ binary: null, rulesDir });
    const result = await scanner.scan({ root });
    assert.equal(result.available, false);
    assert.equal(result.ok, false);
    assert.equal(result.gate, "unavailable");
    assert.deepEqual(result.findings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
