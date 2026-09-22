import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeFileAtomic } from "../file-state.mjs";
import { IMPROVEMENT_CATEGORIES, stableFingerprint } from "./candidate-schema.mjs";

const VERSION = 1;
const STATES = Object.freeze(["draft", "shadow", "validated", "blocking"]);
const CATEGORY_SET = new Set(IMPROVEMENT_CATEGORIES);

export function createRegressionRuleStore({
  statePath,
  rulesDir,
  now = () => Date.now(),
  minBlockingRuns = 5
} = {}) {
  const state = { version: VERSION, rules: {} };
  let loaded = false;

  async function load() {
    if (loaded) return snapshot();
    loaded = true;
    if (!statePath) return snapshot();
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      state.rules = parsed?.rules && typeof parsed.rules === "object" ? parsed.rules : {};
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return snapshot();
  }

  async function draft(input = {}) {
    await load();
    const rule = normalizeDraft(input);
    if (state.rules[rule.id]) throw new Error(`Regression rule already exists: ${rule.id}`);
    const timestamp = now();
    const entry = {
      id: rule.id,
      state: "draft",
      created_at: timestamp,
      updated_at: timestamp,
      rule,
      fixture: {
        before: boundedText(input.before, 20_000),
        after: boundedText(input.after, 20_000)
      },
      validation: {
        runs: 0,
        false_positives: 0,
        fixture_passed: false,
        current_clean: false,
        last_scan_at: null,
        last_fixture_at: null
      }
    };
    state.rules[entry.id] = entry;
    await writeRuleConfig(entry);
    await persist();
    return publicEntry(entry);
  }

  async function list({ state: filterState = null } = {}) {
    await load();
    return Object.values(state.rules)
      .filter((entry) => !filterState || entry.state === filterState)
      .sort((left, right) => Number(right.updated_at || 0) - Number(left.updated_at || 0))
      .map(publicEntry);
  }

  async function get(id) {
    await load();
    const entry = state.rules[normalizeRuleId(id, { prefix: false })];
    return entry ? publicEntry(entry) : null;
  }

  async function observe({ id, falsePositive = false, currentClean, fixturePassed } = {}) {
    await load();
    const entry = requireEntry(id);
    if (falsePositive) entry.validation.false_positives += 1;
    if (typeof currentClean === "boolean") entry.validation.current_clean = currentClean;
    if (typeof fixturePassed === "boolean") {
      entry.validation.fixture_passed = fixturePassed;
      entry.validation.last_fixture_at = now();
    }
    entry.validation.last_scan_at = now();
    entry.updated_at = now();
    await persist();
    return publicEntry(entry);
  }

  async function recordFixture(id, passed) {
    await load();
    const entry = requireEntry(id);
    entry.validation.fixture_passed = passed === true;
    entry.validation.last_fixture_at = now();
    entry.updated_at = now();
    await persist();
    return publicEntry(entry);
  }

  async function recordScan({ matchedRuleIds = [], complete = false } = {}) {
    await load();
    if (!complete) return { recorded: false, reason: "targeted_or_failed_scan", rules: 0 };
    const matched = new Set((matchedRuleIds || []).map((value) => String(value)));
    let count = 0;
    const timestamp = now();
    for (const entry of Object.values(state.rules)) {
      if (entry.state === "draft") continue;
      entry.validation.runs += 1;
      entry.validation.current_clean = !matched.has(entry.id);
      entry.validation.last_scan_at = timestamp;
      entry.updated_at = timestamp;
      count += 1;
    }
    if (count) await persist();
    return { recorded: true, rules: count };
  }

  async function promote({ id, to } = {}) {
    await load();
    const entry = requireEntry(id);
    const target = normalizeState(to);
    const currentIndex = STATES.indexOf(entry.state);
    const targetIndex = STATES.indexOf(target);
    if (targetIndex !== currentIndex + 1) {
      return {
        ok: false,
        blocked: true,
        reason: "invalid_transition",
        from: entry.state,
        to: target,
        rule: publicEntry(entry)
      };
    }

    const requirements = promotionRequirements(entry, target, minBlockingRuns);
    if (!requirements.ok) {
      return {
        ok: false,
        blocked: true,
        reason: "promotion_requirements",
        from: entry.state,
        to: target,
        requirements,
        rule: publicEntry(entry)
      };
    }

    entry.state = target;
    entry.updated_at = now();
    await writeRuleConfig(entry);
    await persist();
    return {
      ok: true,
      blocked: false,
      from: STATES[currentIndex],
      to: target,
      requirements,
      rule: publicEntry(entry)
    };
  }

  async function activeConfigs() {
    await load();
    return Object.values(state.rules)
      .filter((entry) => entry.state !== "draft")
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entry) => ({
        id: entry.id,
        state: entry.state,
        path: ruleConfigPath(entry.id),
        declared_severity: entry.rule.severity
      }));
  }

  function snapshot() {
    return {
      version: VERSION,
      min_blocking_runs: minBlockingRuns,
      rules: structuredClone(state.rules)
    };
  }

  function requireEntry(id) {
    const normalized = normalizeRuleId(id, { prefix: false });
    const entry = state.rules[normalized];
    if (!entry) throw new Error(`Unknown regression rule: ${normalized}`);
    return entry;
  }

  function ruleConfigPath(id) {
    return path.join(rulesDir, `${safeFileName(id)}.yml`);
  }

  async function writeRuleConfig(entry) {
    if (!rulesDir) return;
    await writeFileAtomic(ruleConfigPath(entry.id), Buffer.from(renderLearnedRuleYaml(entry), "utf8"));
  }

  async function persist() {
    if (!statePath) return;
    await writeFileAtomic(statePath, Buffer.from(`${JSON.stringify(snapshot(), null, 2)}\n`, "utf8"));
  }

  return {
    load,
    draft,
    list,
    get,
    observe,
    recordFixture,
    recordScan,
    promote,
    activeConfigs,
    snapshot
  };
}

export function renderLearnedRuleYaml(entry, { includePaths = true, stateOverride = null } = {}) {
  const lifecycleState = stateOverride || entry.state || "draft";
  const rule = entry.rule || {};
  const patternKey = rule.kind === "pattern-regex" ? "pattern-regex" : "pattern";
  const lines = [
    "rules:",
    `  - id: ${yamlScalar(entry.id)}`,
    `    message: ${yamlScalar(rule.message || "Learned LCA regression rule")}`,
    `    severity: ${normalizeSeverity(rule.severity)}`,
    `    languages: [${(rule.languages || ["generic"]).map(yamlScalar).join(", ")}]`,
    `    ${patternKey}: ${yamlScalar(rule.pattern || "")}`
  ];
  if (includePaths && Array.isArray(rule.paths) && rule.paths.length) {
    lines.push("    paths:", "      include:");
    for (const value of rule.paths) lines.push(`        - ${yamlScalar(value)}`);
  }
  lines.push(
    "    metadata:",
    `      lca_category: ${yamlScalar(rule.category || "CORRECTNESS")}`,
    `      component: ${yamlScalar(rule.component || "learned-regression")}`,
    "      lca_rule_origin: learned",
    `      lca_rule_state: ${yamlScalar(lifecycleState)}`,
    `      lca_declared_severity: ${yamlScalar(normalizeSeverity(rule.severity))}`
  );
  return `${lines.join("\n")}\n`;
}

export async function validateRegressionRuleFixture({
  entry,
  semgrepBinary = null,
  spawnCapture = null,
  astGrepSearch = null,
  timeoutMs = 30_000
} = {}) {
  const before = String(entry?.fixture?.before || "");
  const after = String(entry?.fixture?.after || "");
  if (!before || !after) {
    return { available: false, passed: false, engine: null, reason: "fixture_missing" };
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-rule-fixture-"));
  const extension = extensionForLanguage(entry?.rule?.languages?.[0]);
  const beforePath = path.join(dir, `before.${extension}`);
  const afterPath = path.join(dir, `after.${extension}`);
  try {
    await writeFile(beforePath, before, "utf8");
    await writeFile(afterPath, after, "utf8");

    if (semgrepBinary && typeof spawnCapture === "function") {
      const configPath = path.join(dir, "fixture-rule.yml");
      await writeFile(configPath, renderLearnedRuleYaml(entry, {
        includePaths: false,
        stateOverride: "blocking"
      }), "utf8");
      const result = await spawnCapture(semgrepBinary, [
        "scan",
        "--config", configPath,
        "--json",
        "--metrics=off",
        "--disable-version-check",
        "--quiet",
        beforePath,
        afterPath
      ], dir, timeoutMs);
      if (result.exit_code !== 0 || result.timed_out) {
        return {
          available: true,
          passed: false,
          engine: "semgrep",
          reason: result.timed_out ? "timeout" : "engine_error"
        };
      }
      let parsed;
      try { parsed = JSON.parse(String(result.stdout || "{}")); }
      catch { return { available: true, passed: false, engine: "semgrep", reason: "invalid_json" }; }
      const hits = Array.isArray(parsed?.results) ? parsed.results : [];
      const beforeHits = hits.filter((hit) => path.basename(String(hit.path || "")) === path.basename(beforePath)).length;
      const afterHits = hits.filter((hit) => path.basename(String(hit.path || "")) === path.basename(afterPath)).length;
      return {
        available: true,
        passed: beforeHits > 0 && afterHits === 0,
        engine: "semgrep",
        before_hits: beforeHits,
        after_hits: afterHits
      };
    }

    if (entry?.rule?.kind === "pattern" && astGrepSearch?.search) {
      const lang = astGrepLanguage(entry?.rule?.languages?.[0]);
      const [beforeResult, afterResult] = await Promise.all([
        astGrepSearch.search({ start: beforePath, pattern: entry.rule.pattern, lang, limit: 20 }),
        astGrepSearch.search({ start: afterPath, pattern: entry.rule.pattern, lang, limit: 20 })
      ]);
      if (beforeResult.available === false || afterResult.available === false) {
        return { available: false, passed: false, engine: "ast-grep", reason: "ast_grep_unavailable" };
      }
      return {
        available: true,
        passed: Number(beforeResult.count || 0) > 0 && Number(afterResult.count || 0) === 0,
        engine: "ast-grep",
        before_hits: Number(beforeResult.count || 0),
        after_hits: Number(afterResult.count || 0)
      };
    }

    if (entry?.rule?.kind === "pattern-regex") {
      try {
        const regex = new RegExp(entry.rule.pattern, "m");
        return {
          available: true,
          passed: regex.test(before) && !regex.test(after),
          engine: "regex-fixture",
          before_hits: regex.test(before) ? 1 : 0,
          after_hits: regex.test(after) ? 1 : 0
        };
      } catch {
        return { available: true, passed: false, engine: "regex-fixture", reason: "invalid_regex" };
      }
    }

    return { available: false, passed: false, engine: null, reason: "validator_unavailable" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function promotionRequirements(entry, target, minBlockingRuns = 5) {
  const validation = entry?.validation || {};
  if (target === "shadow") return { ok: true };
  if (target === "validated") {
    return {
      ok: validation.fixture_passed === true,
      fixture_passed: validation.fixture_passed === true
    };
  }
  if (target === "blocking") {
    const requirements = {
      min_runs: Math.max(1, Number(minBlockingRuns) || 5),
      runs: Number(validation.runs || 0),
      zero_false_positives: Number(validation.false_positives || 0) === 0,
      false_positives: Number(validation.false_positives || 0),
      fixture_passed: validation.fixture_passed === true,
      current_clean: validation.current_clean === true
    };
    return {
      ...requirements,
      ok: requirements.runs >= requirements.min_runs
        && requirements.zero_false_positives
        && requirements.fixture_passed
        && requirements.current_clean
    };
  }
  return { ok: false };
}

function normalizeDraft(input) {
  const before = boundedText(input.before, 20_000);
  const providedPattern = boundedText(input.pattern || input.pattern_regex, 20_000);
  const pattern = providedPattern || before;
  if (!pattern) throw new Error("Regression rule requires pattern/pattern_regex or a before fixture.");
  const kind = input.pattern_regex ? "pattern-regex" : "pattern";
  const fingerprint = stableFingerprint({
    pattern,
    kind,
    language: input.lang || input.language || "generic",
    paths: input.paths || []
  });
  const id = normalizeRuleId(input.id || fingerprint.slice(0, 16), { prefix: true });
  return {
    id,
    message: boundedText(input.message, 500) || `Prevent learned regression ${id}.`,
    languages: [boundedText(input.lang || input.language, 40) || "generic"],
    kind,
    pattern,
    paths: uniqueStrings(input.paths, 50, 500),
    severity: normalizeSeverity(input.severity),
    category: normalizeCategory(input.category),
    component: boundedText(input.component, 160) || "learned-regression"
  };
}

function normalizeRuleId(value, { prefix = false } = {}) {
  let id = String(value || "").trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) throw new Error("Regression rule id is required.");
  if (prefix && !id.startsWith("lca.learned.")) id = `lca.learned.${id}`;
  return id.slice(0, 180);
}

function normalizeState(value) {
  const state = String(value || "").trim().toLowerCase();
  if (!STATES.includes(state)) throw new Error(`Invalid regression rule state: ${state}`);
  return state;
}

function normalizeSeverity(value) {
  const severity = String(value || "ERROR").trim().toUpperCase();
  return ["ERROR", "WARNING", "INFO"].includes(severity) ? severity : "ERROR";
}

function normalizeCategory(value) {
  const category = String(value || "CORRECTNESS").trim().toUpperCase();
  return CATEGORY_SET.has(category) ? category : "CORRECTNESS";
}

function publicEntry(entry) {
  return JSON.parse(JSON.stringify(entry));
}

function safeFileName(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 180);
}

function yamlScalar(value) {
  return JSON.stringify(String(value ?? ""));
}

function extensionForLanguage(value) {
  const lang = String(value || "").toLowerCase();
  if (lang === "typescript" || lang === "ts") return "ts";
  if (lang === "tsx") return "tsx";
  if (lang === "javascript" || lang === "js") return "js";
  if (lang === "jsx") return "jsx";
  if (lang === "python") return "py";
  if (lang === "java") return "java";
  return "txt";
}

function astGrepLanguage(value) {
  const lang = String(value || "").toLowerCase();
  if (lang === "typescript") return "ts";
  if (lang === "javascript") return "js";
  return lang || "generic";
}

function boundedText(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function uniqueStrings(values, maxItems, maxChars) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().slice(0, maxChars)))]
    .slice(0, maxItems);
}
