import { validateRegressionRuleFixture } from "./regression-rule-store.mjs";

export function createRegressionRuleManager({
  storeForRoot,
  semgrepBinary = null,
  spawnCapture = null,
  astGrepSearch = null
} = {}) {
  if (typeof storeForRoot !== "function") throw new Error("Regression rule manager requires storeForRoot.");

  async function store(root) {
    const value = await storeForRoot(root);
    if (!value) throw new Error("Regression rule store is unavailable.");
    return value;
  }

  async function activeConfigs(root) {
    return (await store(root)).activeConfigs();
  }

  async function recordScan(root, observation) {
    return (await store(root)).recordScan(observation);
  }

  async function manage(root, input = {}) {
    const rules = await store(root);
    const operation = String(input.operation || "list").trim().toLowerCase();

    if (operation === "list") {
      return {
        ok: true,
        operation,
        rules: await rules.list({ state: input.state || null })
      };
    }

    if (operation === "draft") {
      return { ok: true, operation, rule: await rules.draft(input) };
    }

    if (operation === "validate_fixture") {
      if (!input.id) throw new Error("semgrep_rules validate_fixture requires id.");
      const rule = await rules.get(input.id);
      if (!rule) throw new Error(`Unknown regression rule: ${input.id}`);
      const validation = await validateRegressionRuleFixture({
        entry: rule,
        semgrepBinary,
        spawnCapture,
        astGrepSearch,
        timeoutMs: input.timeout_ms || 30_000
      });
      const updated = await rules.recordFixture(input.id, validation.passed === true);
      return { ok: validation.passed === true, operation, validation, rule: updated };
    }

    if (operation === "feedback") {
      if (!input.id) throw new Error("semgrep_rules feedback requires id.");
      const rule = await rules.observe({
        id: input.id,
        falsePositive: input.false_positive === true
      });
      return { ok: true, operation, rule };
    }

    if (operation === "promote") {
      if (!input.id || !input.to) throw new Error("semgrep_rules promote requires id and to.");
      return { operation, ...(await rules.promote({ id: input.id, to: input.to })) };
    }

    throw new Error(`Unknown semgrep_rules operation: ${operation}`);
  }

  return { activeConfigs, recordScan, manage };
}
