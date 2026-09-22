import { readdir } from "node:fs/promises";
import path from "node:path";

import { IMPROVEMENT_CATEGORIES, stableFingerprint } from "./self-improvement/candidate-schema.mjs";

const CATEGORY_SET = new Set(IMPROVEMENT_CATEGORIES);
const DEFAULT_TIMEOUT_MS = 120_000;

export function createSemgrepScanner({
  binary = null,
  rulesDir,
  spawnCapture,
  toRel = (value) => value,
  recordCandidates = null,
  additionalRuleConfigs = null,
  recordRuleScan = null,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  async function scan({ root, paths = [], timeoutMs = defaultTimeoutMs, maxResults = 200 } = {}) {
    const resolvedRoot = path.resolve(root || ".");
    const limit = Math.max(1, Math.min(1000, Number(maxResults) || 200));
    const staticConfigs = await collectSemgrepRuleConfigs(rulesDir);
    const learnedValues = typeof additionalRuleConfigs === "function"
      ? await additionalRuleConfigs(resolvedRoot)
      : [];
    const learnedConfigs = (Array.isArray(learnedValues) ? learnedValues : [])
      .map((value) => typeof value === "string" ? value : value?.path)
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => path.resolve(value));
    const configs = [...new Set([...staticConfigs, ...learnedConfigs])].sort();

    if (!binary) {
      return {
        engine: "semgrep",
        available: false,
        ok: false,
        gate: "unavailable",
        reason: "semgrep_cli_unavailable",
        rules: configs.map((value) => path.relative(rulesDir || resolvedRoot, value).replaceAll("\\", "/")),
        summary: emptySummary(),
        findings: [],
        candidate_ingestion: emptyIngestion()
      };
    }
    if (!configs.length) {
      return {
        engine: "semgrep",
        available: true,
        ok: false,
        gate: "fail",
        reason: "semgrep_rules_missing",
        rules: [],
        summary: emptySummary(),
        findings: [],
        candidate_ingestion: emptyIngestion()
      };
    }
    if (typeof spawnCapture !== "function") throw new Error("Semgrep scanner requires spawnCapture.");

    const targets = normalizeTargets(resolvedRoot, paths);
    const args = buildSemgrepArgs({ configs, targets });
    const processResult = await spawnCapture(binary, args, resolvedRoot, timeoutMs);
    const parsed = parseSemgrepJson(processResult.stdout);
    if (!parsed.ok) {
      return {
        engine: "semgrep",
        available: true,
        ok: false,
        gate: "fail",
        reason: "semgrep_output_invalid",
        error: parsed.error,
        exit_code: processResult.exit_code,
        timed_out: processResult.timed_out === true,
        rules: configs.map((value) => relativeRulePath(rulesDir, value)),
        targets: targets.map((value) => displayTarget(resolvedRoot, value)),
        summary: emptySummary(),
        findings: [],
        candidate_ingestion: emptyIngestion()
      };
    }

    const normalized = normalizeSemgrepOutput(parsed.value, {
      root: resolvedRoot,
      toRel,
      maxResults: limit
    });
    const matchedRuleIds = [...new Set((Array.isArray(parsed.value?.results) ? parsed.value.results : [])
      .map((entry) => safeText(entry?.check_id, 240))
      .filter(Boolean))];
    const engineErrors = normalizeEngineErrors(parsed.value?.errors);
    const engineOk = processResult.exit_code === 0 && processResult.timed_out !== true && engineErrors.length === 0;
    const warningCandidates = normalized.findings
      .filter((finding) => finding.severity === "WARNING")
      .map(warningFindingToCandidate);
    let candidateIngestion = emptyIngestion(warningCandidates.length);
    if (warningCandidates.length && typeof recordCandidates === "function") {
      try {
        candidateIngestion = await recordCandidates(resolvedRoot, warningCandidates);
      } catch (error) {
        candidateIngestion = {
          ...emptyIngestion(warningCandidates.length),
          error: String(error?.message || error).slice(0, 500)
        };
      }
    }

    let lifecycleObservation = null;
    if (typeof recordRuleScan === "function") {
      try {
        lifecycleObservation = await recordRuleScan(resolvedRoot, {
          matchedRuleIds,
          complete: engineOk && (!Array.isArray(paths) || paths.length === 0)
        });
      } catch (error) {
        lifecycleObservation = {
          recorded: false,
          reason: "lifecycle_persistence_failed",
          error: String(error?.message || error).slice(0, 500)
        };
      }
    }

    const ok = engineOk && normalized.summary.error === 0;
    return {
      engine: "semgrep",
      available: true,
      ok,
      gate: ok ? "pass" : "fail",
      reason: engineOk ? null : "semgrep_engine_error",
      exit_code: processResult.exit_code,
      timed_out: processResult.timed_out === true,
      rules: configs.map((value) => relativeRulePath(rulesDir, value)),
      targets: targets.map((value) => displayTarget(resolvedRoot, value)),
      summary: normalized.summary,
      findings: normalized.findings,
      engine_errors: engineErrors,
      candidate_ingestion: candidateIngestion,
      lifecycle_observation: lifecycleObservation,
      telemetry: {
        info_findings: normalized.summary.info,
        warning_findings: normalized.summary.warning,
        error_findings: normalized.summary.error
      }
    };
  }

  return { scan };
}

export async function collectSemgrepRuleConfigs(rulesDir) {
  if (!rulesDir) return [];
  const result = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (/\.ya?ml$/i.test(entry.name)) result.push(absolute);
    }
  }
  await walk(path.resolve(rulesDir));
  return result.sort();
}

export function buildSemgrepArgs({ configs = [], targets = ["."] } = {}) {
  const args = ["scan"];
  for (const config of configs) args.push("--config", config);
  args.push(
    "--json",
    "--metrics=off",
    "--disable-version-check",
    "--quiet"
  );
  args.push(...targets);
  return args;
}

export function normalizeSemgrepOutput(value, { root, toRel = (entry) => entry, maxResults = 200 } = {}) {
  const rawResults = Array.isArray(value?.results) ? value.results : [];
  const findings = rawResults
    .slice(0, maxResults)
    .map((entry) => normalizeFinding(entry, { root, toRel }));
  const severities = rawResults.map((entry) => effectiveSeverity(entry?.extra));
  const summary = {
    findings: rawResults.length,
    returned: findings.length,
    truncated: rawResults.length > findings.length,
    error: severities.filter((severity) => severity === "ERROR").length,
    warning: severities.filter((severity) => severity === "WARNING").length,
    info: severities.filter((severity) => severity === "INFO").length
  };
  return { summary, findings };
}

export function warningFindingToCandidate(finding) {
  const fingerprint = stableFingerprint({
    source: "semgrep",
    rule_id: finding.rule_id,
    path: finding.path,
    line: finding.line,
    column: finding.column
  });
  return {
    source: ["semgrep"],
    fingerprint,
    category: normalizeCategory(finding.metadata?.lca_category),
    component: safeText(finding.metadata?.component, 160) || safeText(finding.rule_id, 160) || "semgrep",
    affected_paths: finding.path ? [finding.path] : [],
    evidence: {
      fingerprint,
      rule_id: finding.rule_id,
      severity: "WARNING",
      path: finding.path,
      line: finding.line,
      column: finding.column,
      message: finding.message
    },
    baseline: null,
    confidence: 0.98,
    impact: boundedRatio(finding.metadata?.lca_impact, 0.6),
    frequency: boundedRatio(finding.metadata?.lca_frequency, 0.5),
    estimated_cost: boundedRatio(finding.metadata?.lca_cost, 0.35),
    regression_probability: 1,
    estimated_benefit: `Resolve Semgrep warning ${finding.rule_id}.`
  };
}

function normalizeFinding(entry, { root, toRel }) {
  const rawPath = String(entry?.path || "");
  const absolute = rawPath
    ? (path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(root, rawPath))
    : root;
  const extra = entry?.extra && typeof entry.extra === "object" ? entry.extra : {};
  const metadata = extra?.metadata && typeof extra.metadata === "object" ? sanitizeMetadata(extra.metadata) : {};
  return {
    rule_id: safeText(entry?.check_id, 240) || "unknown-rule",
    path: toRel(absolute),
    line: positiveInteger(entry?.start?.line),
    column: positiveInteger(entry?.start?.col),
    end_line: positiveInteger(entry?.end?.line),
    end_column: positiveInteger(entry?.end?.col),
    severity: effectiveSeverity(extra),
    message: safeText(extra?.message, 600) || "Semgrep finding",
    metadata
  };
}

function effectiveSeverity(extra = {}) {
  const metadata = extra?.metadata && typeof extra.metadata === "object" ? extra.metadata : {};
  const state = String(metadata?.lca_rule_state || "").trim().toLowerCase();
  if (state === "draft" || state === "shadow") return "INFO";
  if (state === "validated") return "WARNING";
  if (state === "blocking") return normalizeSeverity(metadata?.lca_declared_severity || extra?.severity);
  return normalizeSeverity(extra?.severity);
}

function normalizeSeverity(value) {
  const severity = String(value || "INFO").trim().toUpperCase();
  if (severity === "ERROR" || severity === "WARNING" || severity === "INFO") return severity;
  return "INFO";
}

function normalizeCategory(value) {
  const category = String(value || "CODE_HEALTH").trim().toUpperCase();
  return CATEGORY_SET.has(category) ? category : "CODE_HEALTH";
}

function sanitizeMetadata(value) {
  const allowed = [
    "lca_category", "component", "lca_impact", "lca_frequency", "lca_cost", "confidence",
    "lca_rule_origin", "lca_rule_state", "lca_declared_severity"
  ];
  return Object.fromEntries(allowed
    .filter((key) => value?.[key] !== undefined)
    .map((key) => [key, typeof value[key] === "string" ? safeText(value[key], 240) : value[key]]));
}

function normalizeEngineErrors(errors) {
  return (Array.isArray(errors) ? errors : []).slice(0, 50).map((entry) => ({
    type: safeText(entry?.type || entry?.code, 120) || "semgrep-error",
    message: safeText(entry?.message || entry?.long_msg || entry?.short_msg, 500) || "Semgrep engine error",
    ...(entry?.path ? { path: safeText(entry.path, 500) } : {})
  }));
}

function parseSemgrepJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return { ok: false, error: "Semgrep returned empty JSON output." };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: `Could not parse Semgrep JSON: ${String(error?.message || error).slice(0, 500)}` };
  }
}

function normalizeTargets(root, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return ["."];
  return [...new Set(paths.map((value) => path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(root, String(value))))];
}

function displayTarget(root, target) {
  if (target === ".") return ".";
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.replaceAll("\\", "/")
    : target;
}

function relativeRulePath(rulesDir, value) {
  return rulesDir
    ? path.relative(rulesDir, value).replaceAll("\\", "/")
    : value;
}

function emptySummary() {
  return { findings: 0, returned: 0, truncated: false, error: 0, warning: 0, info: 0 };
}

function emptyIngestion(detected = 0) {
  return { detected, added: 0, existing: 0, total: 0 };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function safeText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function boundedRatio(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0.01, Math.min(1, number));
}
