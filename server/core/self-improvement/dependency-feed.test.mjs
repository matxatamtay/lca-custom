import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createRenovateDependencyFeed,
  dependencyRisk,
  extractRenovateUpdates,
  parseRenovateDocument
} from "./dependency-feed.mjs";

test("parses canonical and Renovate-style dependency updates into advisory candidates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-renovate-feed-"));
  const report = path.join(root, ".renovate", "dependency-feed.json");
  await mkdir(path.dirname(report), { recursive: true });
  const payload = {
    packageFiles: [{
      packageFile: "package.json",
      deps: [{
        depName: "@modelcontextprotocol/sdk",
        currentVersion: "1.2.3",
        datasource: "npm",
        updates: [{
          newVersion: "2.0.0",
          updateType: "major",
          changelogUrl: "https://example.invalid/changelog"
        }]
      }]
    }]
  };
  await writeFile(report, JSON.stringify(payload), "utf8");
  const before = await readFile(report, "utf8");
  try {
    const feed = createRenovateDependencyFeed({ hasCommand: () => false });
    const result = await feed.inspect({ root });
    assert.equal(result.available, true);
    assert.equal(result.ok, true);
    assert.equal(result.binary.executed, false);
    assert.equal(result.auto_apply, false);
    assert.equal(result.auto_merge, false);
    assert.equal(result.candidates.length, 1);
    const candidate = result.candidates[0];
    assert.equal(candidate.category, "DEPENDENCY");
    assert.equal(candidate.evidence.package, "@modelcontextprotocol/sdk");
    assert.equal(candidate.evidence.from, "1.2.3");
    assert.equal(candidate.evidence.to, "2.0.0");
    assert.equal(candidate.evidence.risk, "high");
    assert.deepEqual(candidate.affected_paths, ["package.json"]);
    assert.equal(candidate.evidence.evaluation.auto_apply, false);
    assert.equal(candidate.evidence.evaluation.auto_merge, false);
    assert.deepEqual(await readFile(report, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSONL Renovate logs can be consumed without raw command execution", () => {
  const document = parseRenovateDocument([
    JSON.stringify({ msg: "noise" }),
    JSON.stringify({
      depName: "zod",
      currentValue: "^3.22.0",
      newValue: "^3.23.0",
      updateType: "minor",
      packageFile: "server/package.json"
    })
  ].join("\n"));
  const updates = extractRenovateUpdates(document);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].package, "zod");
  assert.equal(updates[0].update_type, "minor");
  assert.deepEqual(updates[0].affected_files, ["server/package.json"]);
});

test("risk metadata prefers Renovate update type then semver delta", () => {
  assert.equal(dependencyRisk({ update_type: "major" }).level, "high");
  assert.equal(dependencyRisk({ update_type: "minor" }).level, "medium");
  assert.equal(dependencyRisk({ update_type: "patch" }).level, "low");
  assert.equal(dependencyRisk({ from: "1.2.3", to: "2.0.0" }).level, "high");
  assert.equal(dependencyRisk({ from: "1.2.3", to: "1.3.0" }).level, "medium");
  assert.equal(dependencyRisk({ from: "1.2.3", to: "1.2.4" }).level, "low");
});

test("missing report is a structured unavailable feed even when Renovate binary exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-renovate-missing-"));
  try {
    const feed = createRenovateDependencyFeed({ hasCommand: (name) => name === "renovate" });
    const result = await feed.inspect({ root });
    assert.equal(result.available, false);
    assert.equal(result.ok, true);
    assert.equal(result.reason, "renovate_feed_report_unavailable");
    assert.equal(result.binary.available, true);
    assert.equal(result.binary.executed, false);
    assert.equal(result.analysis_only, true);
    assert.equal(result.auto_merge, false);
    assert.deepEqual(result.candidates, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
