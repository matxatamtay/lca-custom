import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compactAutotuningHint, compactVerificationHint, likelyReadHints, readContextSourcePreviews, resolveContextChangedFiles } from "./repo-intel-tools.mjs";

test("inline source previews are small, useful and cannot escape the project through symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-preview-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "lca-preview-outside-"));
  try {
    await mkdir(path.join(root, "src"));
    const source = path.join(root, "src", "example.ts");
    await writeFile(source, Array.from({ length: 30 }, (_, i) => `export const item${i} = ${i};`).join("\n"));
    await writeFile(path.join(outside, "private.ts"), "SECRET_OUTSIDE_PROJECT");
    await symlink(path.join(outside, "private.ts"), path.join(root, "src", "linked.ts"));
    const result = await readContextSourcePreviews(root, [
      { path: path.join(root, "src", "linked.ts") },
      { path: source, line: 12 },
      { path: path.join(outside, "private.ts") }
    ], 800);
    assert.equal(result.length, 1);
    assert.equal(result[0].path, source);
    assert.match(result[0].content, /item4/);
    assert.ok(result[0].content.length <= 800);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_OUTSIDE_PROJECT/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("explicit workspace_context paths resolve relative changed files from the requested root", () => {
  const routed = [];
  const result = resolveContextChangedFiles(["server.mjs", "tools/repo-intel-tools.mjs"], {
    hasExplicitPath: true,
    rootDir: "/repo/server",
    resolvePath(value) { routed.push(value); return `/wrong/${value}`; }
  });

  assert.deepEqual(result, ["/repo/server/server.mjs", "/repo/server/tools/repo-intel-tools.mjs"]);
  assert.deepEqual(routed, []);
});

test("likely read hints prioritize changed files before selected evidence and dedupe paths", () => {
  const result = likelyReadHints([
    {
      path: "/repo/src/a.ts",
      provider: "filesystem",
      title: "a.ts:20",
      metadata: { line: 20, slice_start: 15, slice_end: 25 }
    },
    {
      path: "/repo/src/b.ts",
      provider: "semantic",
      title: "symbol B",
      symbol: "B"
    }
  ], ["/repo/src/a.ts", "/repo/src/changed.ts"]);

  assert.deepEqual(result.map((item) => item.path), [
    "/repo/src/a.ts",
    "/repo/src/changed.ts",
    "/repo/src/b.ts"
  ]);
  assert.equal(result[0].reason, "changed_file");
  assert.equal(result[2].provider, "semantic");
  assert.equal(result[2].symbol, "B");
});

test("verification hints are compact and expose prefetch/cache state without auto-running", () => {
  const hint = compactVerificationHint({
    strategy: "targeted",
    impacted_tests: Array.from({ length: 15 }, (_, index) => `test-${index}.ts`),
    gates: Array.from({ length: 8 }, (_, index) => ({
      name: `gate-${index}`,
      command: `command-${index}`,
      scope: "targeted",
      reason: "relevant"
    })),
    cache: { hits: 2 },
    prefetch: { cache_hit: true }
  });

  assert.equal(hint.strategy, "targeted");
  assert.equal(hint.impacted_tests.length, 10);
  assert.equal(hint.gates.length, 6);
  assert.equal(hint.cache_hits, 2);
  assert.equal(hint.prefetch_hit, true);
  assert.equal(hint.auto_run, false);
});

test("autotuning hints omit duplicate raw telemetry while preserving applied budget decisions", () => {
  const hint = compactAutotuningHint({
    version: 2,
    mode: "baseline",
    context: { max_items: 10, max_chars: 12_000 },
    prewarm_priority: "high",
    metrics: { samples: 20, avg_roundtrips: 15, avg_bytes_to_model: 140_000 },
    hygiene: { user_only: true },
    reasons: ["high round trips", "cold cache"]
  }, {
    max_items: 10,
    max_chars: 12_000,
    explicit_overrides: { max_items: false, max_chars: false }
  });

  assert.equal(hint.mode, "baseline");
  assert.equal(hint.prewarm_priority, "high");
  assert.equal(hint.applied.max_chars, 12_000);
  assert.equal("metrics" in hint, false);
  assert.equal("hygiene" in hint, false);
});
