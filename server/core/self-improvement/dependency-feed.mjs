import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { stableFingerprint } from "./candidate-schema.mjs";

const DEFAULT_REPORT_NAMES = Object.freeze([
  ".renovate/dependency-feed.json",
  ".renovate/feed.json",
  "renovate-feed.json",
  "renovate-report.json"
]);

export function createRenovateDependencyFeed({
  configuredReportPath = null,
  configuredBinary = null,
  hasCommand = null,
  platform = process.platform
} = {}) {
  async function inspect({ root, reportPath = null } = {}) {
    const resolvedRoot = path.resolve(root || ".");
    const binary = resolveRenovateBinary(resolvedRoot, {
      configuredBinary,
      hasCommand,
      platform
    });
    const report = resolveReportPath(resolvedRoot, reportPath || configuredReportPath);

    if (!report) {
      return {
        engine: "renovate",
        available: false,
        ok: true,
        reason: "renovate_feed_report_unavailable",
        root: resolvedRoot,
        binary: {
          available: Boolean(binary),
          path: binary || null,
          executed: false
        },
        searched_report_paths: reportCandidates(resolvedRoot, reportPath || configuredReportPath),
        analysis_only: true,
        auto_apply: false,
        auto_merge: false,
        candidates: []
      };
    }

    let document;
    try {
      document = parseRenovateDocument(await readFile(report, "utf8"));
    } catch (error) {
      return {
        engine: "renovate",
        available: true,
        ok: false,
        reason: "renovate_feed_parse_failed",
        error: String(error?.message || error).slice(0, 500),
        root: resolvedRoot,
        report_path: report,
        binary: {
          available: Boolean(binary),
          path: binary || null,
          executed: false
        },
        analysis_only: true,
        auto_apply: false,
        auto_merge: false,
        candidates: []
      };
    }

    const updates = extractRenovateUpdates(document);
    const candidates = updates.map(dependencyUpdateToCandidate);
    return {
      engine: "renovate",
      available: true,
      ok: true,
      root: resolvedRoot,
      report_path: report,
      binary: {
        available: Boolean(binary),
        path: binary || null,
        executed: false
      },
      analysis_only: true,
      auto_apply: false,
      auto_merge: false,
      updates: updates.length,
      candidates,
      evaluation_workflow: evaluationWorkflow()
    };
  }

  return { inspect };
}

export function parseRenovateDocument(text) {
  const source = String(text || "").trim();
  if (!source) return {};
  try {
    return JSON.parse(source);
  } catch {
    const rows = [];
    for (const line of source.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* ignore non-JSON log lines */ }
    }
    if (!rows.length) throw new Error("Renovate feed is neither JSON nor JSONL.");
    return rows;
  }
}

export function extractRenovateUpdates(document) {
  const updates = [];
  const visited = new Set();

  const visit = (node, inherited = {}, depth = 0) => {
    if (depth > 8 || !node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node.slice(0, 5_000)) visit(item, inherited, depth + 1);
      return;
    }

    const nextInherited = {
      packageFile: firstText(node.packageFile, node.packageFileName, node.fileName, inherited.packageFile),
      manager: firstText(node.manager, node.datasource, inherited.manager)
    };

    if (looksLikeDependencyUpdate(node)) {
      const normalized = normalizeUpdate({ ...nextInherited, ...node });
      if (normalized) updates.push(normalized);
    }

    if (node.depName && Array.isArray(node.updates)) {
      for (const update of node.updates.slice(0, 100)) {
        const normalized = normalizeUpdate({ ...nextInherited, ...node, ...update });
        if (normalized) updates.push(normalized);
      }
    }

    for (const value of Object.values(node).slice(0, 200)) {
      if (value && typeof value === "object") visit(value, nextInherited, depth + 1);
    }
  };

  visit(document);

  const deduped = new Map();
  for (const update of updates) {
    const key = stableFingerprint({
      package: update.package,
      from: update.from,
      to: update.to,
      affected_files: update.affected_files
    });
    if (!deduped.has(key)) deduped.set(key, update);
  }
  return [...deduped.values()].sort((left, right) => (
    left.package.localeCompare(right.package)
    || left.to.localeCompare(right.to)
  ));
}

export function dependencyUpdateToCandidate(update) {
  const risk = dependencyRisk(update);
  const fingerprint = stableFingerprint({
    source: "renovate",
    package: update.package,
    from: update.from,
    to: update.to,
    affected_files: update.affected_files
  });
  const impact = risk.level === "high" ? 0.8 : risk.level === "medium" ? 0.5 : 0.25;
  const cost = risk.level === "high" ? 0.7 : risk.level === "medium" ? 0.45 : 0.25;
  return {
    source: ["renovate"],
    fingerprint,
    category: "DEPENDENCY",
    component: "dependency:" + update.package,
    affected_paths: update.affected_files,
    evidence: {
      fingerprint,
      package: update.package,
      from: update.from,
      to: update.to,
      changelog: update.changelog,
      risk: risk.level,
      risk_metadata: risk,
      affected_files: update.affected_files,
      manager: update.manager,
      datasource: update.datasource,
      evaluation: evaluationWorkflow()
    },
    baseline: {
      package: update.package,
      version: update.from
    },
    confidence: 0.98,
    impact,
    frequency: 0.5,
    estimated_cost: cost,
    regression_probability: risk.level === "high" ? 0.85 : risk.level === "medium" ? 0.55 : 0.3,
    estimated_benefit: "Evaluate " + update.package + " " + update.from + " → " + update.to
      + " in an isolated worktree before any dependency update is applied."
  };
}

export function dependencyRisk(update = {}) {
  const explicit = String(update.risk || "").trim().toLowerCase();
  if (["high", "medium", "low"].includes(explicit)) {
    return { level: explicit, reason: "feed", update_type: normalizeUpdateType(update) };
  }
  const updateType = normalizeUpdateType(update);
  if (["major", "replacement"].includes(updateType)) {
    return { level: "high", reason: "update_type", update_type: updateType };
  }
  if (["minor", "rollback"].includes(updateType)) {
    return { level: "medium", reason: "update_type", update_type: updateType };
  }
  if (["patch", "pin", "digest"].includes(updateType)) {
    return { level: "low", reason: "update_type", update_type: updateType };
  }

  const semver = semverDelta(update.from, update.to);
  if (semver) {
    return {
      level: semver === "major" ? "high" : semver === "minor" ? "medium" : "low",
      reason: "semver_delta",
      update_type: semver
    };
  }
  return { level: "medium", reason: "unknown_update_shape", update_type: updateType || "unknown" };
}

export function resolveRenovateBinary(root, {
  configuredBinary = null,
  hasCommand = null,
  platform = process.platform
} = {}) {
  const configured = String(configuredBinary || "").trim();
  if (configured) {
    if (path.isAbsolute(configured) && existsSync(configured)) return configured;
    if (typeof hasCommand === "function" && hasCommand(configured)) return configured;
  }

  const name = platform === "win32" ? "renovate.cmd" : "renovate";
  let cursor = path.resolve(root || ".");
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(cursor, "node_modules", ".bin", name);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (typeof hasCommand === "function" && hasCommand("renovate")) return "renovate";
  return null;
}

function normalizeUpdate(value) {
  const packageName = firstText(value.package, value.depName, value.packageName, value.name);
  const from = firstText(value.from, value.currentVersion, value.currentValue, value.currentDigest, "unknown");
  const to = firstText(value.to, value.newVersion, value.newValue, value.newDigest);
  if (!packageName || !to || to === from) return null;
  const affected = uniqueStrings([
    ...(Array.isArray(value.affected_files) ? value.affected_files : []),
    value.packageFile,
    value.packageFileName,
    value.fileName
  ], 50, 500);
  return {
    package: packageName,
    from,
    to,
    changelog: firstText(
      value.changelog,
      value.changelogUrl,
      value.releaseNotes,
      value.releaseNotesUrl,
      value.sourceUrl
    ) || null,
    risk: firstText(value.risk) || null,
    update_type: normalizeUpdateType(value),
    affected_files: affected,
    manager: firstText(value.manager) || null,
    datasource: firstText(value.datasource) || null
  };
}

function looksLikeDependencyUpdate(value) {
  if (!value || typeof value !== "object") return false;
  const packageName = firstText(value.package, value.depName, value.packageName, value.name);
  const next = firstText(value.to, value.newVersion, value.newValue, value.newDigest);
  return Boolean(packageName && next);
}

function normalizeUpdateType(value) {
  if (value?.isMajor === true) return "major";
  if (value?.isMinor === true) return "minor";
  if (value?.isPatch === true) return "patch";
  return firstText(value?.update_type, value?.updateType, value?.type).toLowerCase();
}

function semverDelta(from, to) {
  const left = versionParts(from);
  const right = versionParts(to);
  if (!left || !right) return null;
  if (right[0] !== left[0]) return "major";
  if (right[1] !== left[1]) return "minor";
  if (right[2] !== left[2]) return "patch";
  return null;
}

function versionParts(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function resolveReportPath(root, explicit) {
  for (const candidate of reportCandidates(root, explicit)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function reportCandidates(root, explicit) {
  const candidates = [];
  if (explicit) candidates.push(path.isAbsolute(explicit) ? explicit : path.resolve(root, explicit));
  for (const name of DEFAULT_REPORT_NAMES) candidates.push(path.resolve(root, name));
  return [...new Set(candidates)];
}

function evaluationWorkflow() {
  return {
    mode: "isolated_evaluation",
    analysis_only_feed: true,
    auto_apply: false,
    auto_merge: false,
    steps: [
      "inspect_changelog",
      "create_isolated_worktree",
      "apply_dependency_update_explicitly",
      "install",
      "unit",
      "runtime",
      "compact",
      "pro",
      "benchmark",
      "report"
    ]
  };
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 2_000);
  }
  return "";
}

function uniqueStrings(values, maxItems, maxChars) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().slice(0, maxChars)))]
    .slice(0, maxItems);
}
