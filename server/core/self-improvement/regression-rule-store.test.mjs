import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createRegressionRuleStore,
  promotionRequirements,
  renderLearnedRuleYaml,
  validateRegressionRuleFixture
} from "./regression-rule-store.mjs";

test("learned rules start draft and persist lifecycle metadata without becoming active", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-rule-store-"));
  try {
    const store = createRegressionRuleStore({
      statePath: path.join(dir, "state.json"),
      rulesDir: path.join(dir, "rules"),
      minBlockingRuns: 3
    });
    const rule = await store.draft({
      id: "bad-call",
      message: "Do not call bad()",
      lang: "javascript",
      pattern: "bad(...)",
      before: "bad(input);\n",
      after: "safe(input);\n",
      paths: ["src/**/*.js"]
    });
    assert.equal(rule.state, "draft");
    assert.match(rule.id, /^lca\.learned\./);
    assert.deepEqual(await store.activeConfigs(), []);
    const persisted = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    assert.equal(persisted.rules[rule.id].state, "draft");
    const config = await readFile(path.join(dir, "rules", `${rule.id}.yml`), "utf8");
    assert.match(config, /lca_rule_state: "draft"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("promotion is ordered and blocking requires clean evidence over N runs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-rule-promotion-"));
  try {
    let now = 1_000;
    const store = createRegressionRuleStore({
      statePath: path.join(dir, "state.json"),
      rulesDir: path.join(dir, "rules"),
      minBlockingRuns: 3,
      now: () => now++
    });
    const drafted = await store.draft({
      id: "regression",
      lang: "javascript",
      pattern: "bad(...)",
      before: "bad(a);",
      after: "good(a);"
    });
    const id = drafted.id;
    assert.equal((await store.promote({ id, to: "shadow" })).ok, true);

    const earlyValidated = await store.promote({ id, to: "validated" });
    assert.equal(earlyValidated.ok, false);
    assert.equal(earlyValidated.requirements.fixture_passed, false);

    await store.recordFixture(id, true);
    assert.equal((await store.promote({ id, to: "validated" })).ok, true);

    const earlyBlocking = await store.promote({ id, to: "blocking" });
    assert.equal(earlyBlocking.ok, false);
    assert.equal(earlyBlocking.requirements.runs, 0);

    await store.recordScan({ matchedRuleIds: [], complete: true });
    await store.recordScan({ matchedRuleIds: [], complete: true });
    await store.recordScan({ matchedRuleIds: [], complete: true });
    const blocking = await store.promote({ id, to: "blocking" });
    assert.equal(blocking.ok, true);
    assert.equal(blocking.rule.state, "blocking");

    const config = await readFile(path.join(dir, "rules", `${id}.yml`), "utf8");
    assert.match(config, /lca_rule_state: "blocking"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("one recorded false positive permanently blocks automatic blocking promotion", async () => {
  const entry = {
    validation: {
      runs: 20,
      false_positives: 1,
      fixture_passed: true,
      current_clean: true
    }
  };
  const requirements = promotionRequirements(entry, "blocking", 5);
  assert.equal(requirements.ok, false);
  assert.equal(requirements.zero_false_positives, false);
});

test("shadow and validated lifecycle states are rendered into Semgrep metadata", () => {
  const entry = {
    id: "lca.learned.example",
    state: "shadow",
    rule: {
      message: "example",
      languages: ["typescript"],
      kind: "pattern",
      pattern: "bad(...)",
      paths: ["src/**/*.ts"],
      severity: "ERROR",
      category: "CORRECTNESS",
      component: "example"
    }
  };
  const shadow = renderLearnedRuleYaml(entry);
  assert.match(shadow, /lca_rule_state: "shadow"/);
  assert.match(shadow, /lca_declared_severity: "ERROR"/);
  const validated = renderLearnedRuleYaml({ ...entry, state: "validated" });
  assert.match(validated, /lca_rule_state: "validated"/);
});

test("fixture validation falls back to ast-grep when Semgrep is unavailable", async () => {
  const calls = [];
  const result = await validateRegressionRuleFixture({
    entry: {
      state: "shadow",
      rule: { languages: ["javascript"], kind: "pattern", pattern: "bad(...)" },
      fixture: { before: "bad(input);", after: "safe(input);" }
    },
    semgrepBinary: null,
    astGrepSearch: {
      async search(input) {
        calls.push(input);
        return {
          available: true,
          count: path.basename(input.start).startsWith("before") ? 1 : 0
        };
      }
    }
  });
  assert.equal(result.available, true);
  assert.equal(result.passed, true);
  assert.equal(result.engine, "ast-grep");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].lang, "js");
});
