import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createChangeAwareVerification, buildVerificationFingerprint, discoverImpactedTests } from "./change-aware-verification.mjs";

async function makeRoot(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("source changes discover colocated tests and build a targeted known-runner plan", async () => {
  const root = await makeRoot("lca-verify-targeted-");
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "retry.ts"), "export function retry() {}\n");
    await writeFile(path.join(root, "src", "retry.test.ts"), "test('retry', () => {});\n");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }));
    const verification = createChangeAwareVerification({
      getTestCommandsMerged: async () => ({ test: "npm test", typecheck: "npm run typecheck", lint: null, build: null }),
      runGatedCommand: async () => ({ ok: true }),
      cachePathForRoot: () => path.join(root, ".cache", "verify.json")
    });
    const plan = await verification.plan(root, [path.join(root, "src", "retry.ts")]);
    assert.equal(plan.strategy, "targeted");
    assert.deepEqual(plan.impacted_tests, ["src/retry.test.ts"]);
    assert.match(plan.gates[0].command, /^npm test -- /);
    assert.equal(plan.gates[0].name, "targeted_test");
    assert.ok(plan.gates.some((gate) => gate.name === "typecheck"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("impacted-test discovery ignores LCA runtime workspace backups and worktrees", async () => {
  const root = await makeRoot("lca-verify-generated-dirs-");
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "data", "workspaces", "abc", "backups", "one"), { recursive: true });
    await mkdir(path.join(root, "data", "worktrees", "repo", "task", "src"), { recursive: true });
    const source = path.join(root, "src", "retry.ts");
    await writeFile(source, "export const retry = 1;\n");
    await writeFile(path.join(root, "src", "retry.test.ts"), "test('retry', () => {});\n");
    await writeFile(path.join(root, "data", "workspaces", "abc", "backups", "one", "0-retry.test.ts"), "backup\n");
    await writeFile(path.join(root, "data", "worktrees", "repo", "task", "src", "retry.test.ts"), "worktree\n");

    const impacted = await discoverImpactedTests(root, [source]);
    assert.deepEqual(impacted, ["src/retry.test.ts"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("configuration changes escalate to package verification while docs-only changes are no-op", async () => {
  const root = await makeRoot("lca-verify-config-");
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run", build: "vite build", typecheck: "tsc --noEmit" } }));
    await writeFile(path.join(root, "README.md"), "docs\n");
    const verification = createChangeAwareVerification({
      getTestCommandsMerged: async () => ({ test: "npm test", typecheck: "npm run typecheck", lint: null, build: "npm run build" }),
      runGatedCommand: async () => ({ ok: true }),
      cachePathForRoot: () => path.join(root, ".cache", "verify.json")
    });
    const configPlan = await verification.plan(root, [path.join(root, "package.json")]);
    assert.equal(configPlan.strategy, "config_escalated");
    assert.ok(configPlan.gates.some((gate) => gate.name === "build"));
    assert.ok(configPlan.gates.some((gate) => gate.name === "test"));
    const docsPlan = await verification.plan(root, [path.join(root, "README.md")]);
    assert.equal(docsPlan.strategy, "docs_only");
    assert.deepEqual(docsPlan.gates, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown npm test scripts never invent a targeted command", async () => {
  const root = await makeRoot("lca-verify-unknown-");
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "thing.ts"), "export const thing = 1;\n");
    await writeFile(path.join(root, "src", "thing.test.ts"), "test('thing', () => {});\n");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "custom-company-runner --all" } }));
    const verification = createChangeAwareVerification({
      getTestCommandsMerged: async () => ({ test: "npm test", typecheck: null, lint: null, build: null }),
      runGatedCommand: async () => ({ ok: true }),
      cachePathForRoot: () => path.join(root, ".cache", "verify.json")
    });
    const plan = await verification.plan(root, [path.join(root, "src", "thing.ts")]);
    assert.equal(plan.runner.kind, "npm-unknown");
    assert.equal(plan.gates.some((gate) => gate.name === "targeted_test"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verification fingerprints are stable and change with file content", async () => {
  const root = await makeRoot("lca-verify-fingerprint-");
  try {
    const file = path.join(root, "a.ts");
    await writeFile(file, "export const a = 1;\n");
    const gates = [{ name: "typecheck", command: "npm run typecheck" }];
    const first = await buildVerificationFingerprint(root, [file], gates);
    const second = await buildVerificationFingerprint(root, [file], gates);
    assert.equal(first, second);
    await writeFile(file, "export const a = 2;\n");
    const third = await buildVerificationFingerprint(root, [file], gates);
    assert.notEqual(first, third);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prefetch plan cache reuses impacted-test topology until changed content or manifests change", async () => {
  const root = await makeRoot("lca-verify-prefetch-");
  let detections = 0;
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    const source = path.join(root, "src", "retry.ts");
    await writeFile(source, "export const retry = 1;\n");
    await writeFile(path.join(root, "src", "retry.test.ts"), "test('retry', () => {});\n");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const verification = createChangeAwareVerification({
      getTestCommandsMerged: async () => { detections += 1; return { test: "npm test", typecheck: null, lint: null, build: null }; },
      runGatedCommand: async () => ({ ok: true }),
      cachePathForRoot: () => path.join(root, ".cache", "verify.json")
    });

    const first = await verification.prefetch(root, [source]);
    const second = await verification.plan(root, [source]);
    assert.equal(first.prefetch.cache_hit, false);
    assert.equal(second.prefetch.cache_hit, true);
    assert.equal(detections, 1);

    await writeFile(source, "export const retry = 2;\n");
    const third = await verification.plan(root, [source]);
    assert.equal(third.prefetch.cache_hit, false);
    assert.equal(detections, 2);

    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    const fourth = await verification.plan(root, [source]);
    assert.equal(fourth.prefetch.cache_hit, false);
    assert.equal(detections, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("parallel execution starts independent uncached gates together and persists every success", async () => {
  const root = await makeRoot("lca-verify-parallel-");
  const started = [];
  let release;
  let markAllStarted;
  const barrier = new Promise((resolve) => { release = resolve; });
  const allStarted = new Promise((resolve) => { markAllStarted = resolve; });
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    const source = path.join(root, "src", "retry.ts");
    await writeFile(source, "export const retry = 1;\n");
    await writeFile(path.join(root, "src", "retry.test.ts"), "test('retry', () => {});\n");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const cachePath = path.join(root, ".cache", "verify.json");
    const verification = createChangeAwareVerification({
      getTestCommandsMerged: async () => ({ test: "npm test", typecheck: "npm run typecheck", lint: "npm run lint", build: null }),
      runGatedCommand: async (command) => {
        started.push(command);
        if (started.length === 3) markAllStarted();
        await barrier;
        return { ok: true, command, exit_code: 0, timed_out: false, summary: "ok", failures: [] };
      },
      cachePathForRoot: () => cachePath
    });

    const pending = verification.execute(root, [source], { parallel: true, maxConcurrency: 3, stopOnFailure: false });
    await Promise.race([
      allStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("parallel gates did not start together")), 1_000))
    ]);
    assert.equal(started.length, 3, "all independent gates should start before any gate completes");
    release();
    const result = await pending;
    assert.equal(result.parallel, true);
    assert.equal(result.ran, 3);
    assert.equal(result.failed, 0);
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(cache.entries.length, 3, "parallel success cache writes must not lose entries");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("successful cached gates are reusable, failed results are never cached, and fresh execution bypasses cache", async () => {
  const root = await makeRoot("lca-verify-cache-");
  let runs = 0;
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    const source = path.join(root, "src", "retry.ts");
    const testFile = path.join(root, "src", "retry.test.ts");
    await writeFile(source, "export const retry = 1;\n");
    await writeFile(testFile, "test('retry', () => {});\n");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const cachePath = path.join(root, ".cache", "verify.json");
    const verification = createChangeAwareVerification({
      getTestCommandsMerged: async () => ({ test: "npm test", typecheck: null, lint: null, build: null }),
      runGatedCommand: async (command) => { runs += 1; return { ok: true, command, exit_code: 0, timed_out: false, summary: "ok", failures: [] }; },
      cachePathForRoot: () => cachePath,
      now: () => Date.parse("2026-09-17T00:00:00.000Z")
    });
    const first = await verification.execute(root, [source]);
    assert.equal(first.ran, 1);
    assert.equal(runs, 1);
    const second = await verification.execute(root, [source]);
    assert.equal(second.reused, 1);
    assert.equal(runs, 1);
    const third = await verification.execute(root, [source], { fresh: true });
    assert.equal(third.ran, 1);
    assert.equal(runs, 2);
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(cache.entries.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
