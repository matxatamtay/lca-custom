import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { stableFingerprint } from "./self-improvement/candidate-schema.mjs";

const ELIGIBLE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export function createMutationTestingRunner({
  spawnCapture,
  stateDirForRoot,
  ingestCandidates = null,
  analyzeTestQuality = null,
  configuredBinary = null,
  hasCommand = null,
  platform = process.platform
} = {}) {
  async function run({
    root,
    mode = "changed",
    module: modulePath = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxCandidates = 100,
    criticalPaths = [],
    threshold = null,
    range = null
  } = {}) {
    const resolvedRoot = path.resolve(root || ".");
    const normalizedMode = normalizeMode(mode);
    const binary = resolveStrykerBinary(resolvedRoot, { configuredBinary, hasCommand, platform });
    if (!binary) return unavailableResult(normalizedMode, "stryker_cli_unavailable");
    if (typeof spawnCapture !== "function") return unavailableResult(normalizedMode, "stryker_runner_unavailable");

    const targets = await resolveMutationTargets({
      root: resolvedRoot,
      mode: normalizedMode,
      modulePath,
      spawnCapture
    });
    if (targets.error) {
      return {
        engine: "stryker",
        available: true,
        ok: false,
        gate: "fail",
        mode: normalizedMode,
        reason: targets.error,
        targets: []
      };
    }
    if (normalizedMode !== "full" && targets.files.length === 0) {
      return {
        engine: "stryker",
        available: true,
        ok: true,
        gate: "pass",
        mode: normalizedMode,
        skipped: true,
        reason: "no_eligible_mutation_targets",
        targets: [],
        telemetry: emptyTelemetry()
      };
    }

    const stateDir = typeof stateDirForRoot === "function"
      ? await stateDirForRoot(resolvedRoot)
      : path.join(resolvedRoot, ".lca");
    const incrementalFile = path.join(path.resolve(stateDir), "mutation", "stryker-incremental.json");
    await mkdir(path.dirname(incrementalFile), { recursive: true });
    const beforeState = await fileStamp(incrementalFile);
    const targetSpecs = targets.files.map((value) => toPosix(path.relative(resolvedRoot, value)));
    if (normalizedMode === "module" && range && targetSpecs.length === 1) {
      targetSpecs[0] = formatMutationRange(targetSpecs[0], range);
    }
    const args = buildStrykerArgs({
      incrementalFile,
      mode: normalizedMode,
      targets: targetSpecs
    });

    const startedAt = performance.now();
    const processResult = await spawnCapture(binary, args, resolvedRoot, timeoutMs);
    const durationMs = round(processResult?.duration_ms ?? (performance.now() - startedAt));
    const afterState = await fileStamp(incrementalFile);

    if (processResult?.timed_out === true) {
      return {
        engine: "stryker",
        available: true,
        ok: false,
        gate: "fail",
        mode: normalizedMode,
        reason: "mutation_run_timeout",
        exit_code: processResult.exit_code,
        timed_out: true,
        duration_ms: durationMs,
        targets: publicTargets(resolvedRoot, targets.files),
        incremental_file: incrementalFile,
        telemetry: { ...emptyTelemetry(), duration_ms: durationMs }
      };
    }

    let report;
    try {
      report = JSON.parse(await readFile(incrementalFile, "utf8"));
    } catch (error) {
      return {
        engine: "stryker",
        available: true,
        ok: false,
        gate: "fail",
        mode: normalizedMode,
        reason: "mutation_report_unavailable",
        error: String(error?.message || error).slice(0, 500),
        exit_code: processResult?.exit_code ?? null,
        timed_out: false,
        duration_ms: durationMs,
        targets: publicTargets(resolvedRoot, targets.files),
        incremental_file: incrementalFile,
        report_updated: changedStamp(beforeState, afterState),
        telemetry: { ...emptyTelemetry(), duration_ms: durationMs }
      };
    }

    const parsed = parseMutationReport(report, {
      root: resolvedRoot,
      maxSurvivors: Math.max(1, Math.min(500, Number(maxCandidates) || 100))
    });
    if (!parsed.ok) {
      return {
        engine: "stryker",
        available: true,
        ok: false,
        gate: "fail",
        mode: normalizedMode,
        reason: "mutation_report_invalid",
        error: parsed.error,
        exit_code: processResult?.exit_code ?? null,
        timed_out: false,
        duration_ms: durationMs,
        targets: publicTargets(resolvedRoot, targets.files),
        incremental_file: incrementalFile,
        report_updated: changedStamp(beforeState, afterState),
        telemetry: { ...emptyTelemetry(), duration_ms: durationMs }
      };
    }

    const analysisByPath = {};
    if (parsed.surviving_mutants.length && typeof analyzeTestQuality === "function") {
      for (const sourcePath of [...new Set(parsed.surviving_mutants.map((mutant) => mutant.path).filter(Boolean))]) {
        try {
          analysisByPath[sourcePath] = await analyzeTestQuality(resolvedRoot, sourcePath);
        } catch (error) {
          analysisByPath[sourcePath] = {
            source_change_frequency: 0,
            blast_radius: 0,
            related_tests: [],
            reference_files: [],
            analysis_error: String(error?.message || error).slice(0, 500)
          };
        }
      }
    }
    const candidates = buildTestQualityCandidates(
      parsed.surviving_mutants,
      analysisByPath,
      parsed.telemetry.mutation_score
    );
    let candidateIngestion = { detected: candidates.length, added: 0, existing: 0, total: 0 };
    if (candidates.length && typeof ingestCandidates === "function") {
      try {
        candidateIngestion = await ingestCandidates(resolvedRoot, candidates);
      } catch (error) {
        candidateIngestion = {
          ...candidateIngestion,
          error: String(error?.message || error).slice(0, 500)
        };
      }
    }

    const terminal = parsed.pending === 0;
    const reportUpdated = changedStamp(beforeState, afterState);
    const upstreamExit = Number(processResult?.exit_code ?? 0);
    const engineOk = terminal && (upstreamExit === 0 || reportUpdated);
    const critical = normalizedMode === "changed"
      && Number.isFinite(Number(threshold))
      && Array.isArray(criticalPaths)
      && criticalPaths.length > 0
      && targets.files.some((file) => matchesAnyCriticalPath(toPosix(path.relative(resolvedRoot, file)), criticalPaths));
    const thresholdValue = critical ? clampPercent(threshold) : null;
    const thresholdFailed = critical
      && parsed.telemetry.mutation_score !== null
      && parsed.telemetry.mutation_score < thresholdValue;

    const ok = engineOk && !thresholdFailed;
    return {
      engine: "stryker",
      available: true,
      ok,
      gate: ok ? (candidates.length ? "warn" : "pass") : "fail",
      mode: normalizedMode,
      reason: !engineOk ? "mutation_run_incomplete" : thresholdFailed ? "mutation_threshold" : null,
      exit_code: upstreamExit,
      timed_out: false,
      duration_ms: durationMs,
      targets: normalizedMode === "full" ? ["<project-config/default>"] : publicTargets(resolvedRoot, targets.files),
      incremental_file: incrementalFile,
      report_updated: reportUpdated,
      critical_gate: {
        enabled: critical,
        threshold: thresholdValue,
        failed: thresholdFailed
      },
      telemetry: {
        ...parsed.telemetry,
        duration_ms: durationMs
      },
      surviving_mutants: parsed.surviving_mutants,
      test_quality: {
        paths: analysisByPath,
        candidates: candidates.map((candidate) => ({
          id: candidate.id,
          fingerprint: candidate.fingerprint,
          affected_paths: candidate.affected_paths,
          priority_signal: candidate.evidence?.priority_signal ?? null,
          related_tests: candidate.evidence?.related_tests ?? [],
          rerun: candidate.evidence?.rerun ?? null
        }))
      },
      candidate_ingestion: candidateIngestion,
      ignored_upstream_threshold_exit: upstreamExit !== 0 && engineOk
    };
  }

  return { run };
}

export function resolveStrykerBinary(root, {
  configuredBinary = null,
  hasCommand = null,
  platform = process.platform
} = {}) {
  const configured = String(configuredBinary || "").trim();
  if (configured) {
    if (path.isAbsolute(configured) && existsSync(configured)) return configured;
    if (typeof hasCommand === "function" && hasCommand(configured)) return configured;
  }

  const binName = platform === "win32" ? "stryker.cmd" : "stryker";
  let cursor = path.resolve(root || ".");
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(cursor, "node_modules", ".bin", binName);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (typeof hasCommand === "function" && hasCommand("stryker")) return "stryker";
  return null;
}

export function buildStrykerArgs({ incrementalFile, mode = "changed", targets = [] } = {}) {
  const normalizedMode = normalizeMode(mode);
  const args = [
    "run",
    "--incremental",
    "--incrementalFile", String(incrementalFile),
    "--allowConsoleColors", "false"
  ];
  if (normalizedMode !== "full" && targets.length) {
    args.push("--force", "--mutate", targets.join(","));
  }
  return args;
}

export async function resolveMutationTargets({ root, mode, modulePath, spawnCapture }) {
  const normalizedMode = normalizeMode(mode);
  if (normalizedMode === "full") return { files: [] };

  if (normalizedMode === "changed") {
    const changed = await collectGitFiles(root, spawnCapture, [
      ["diff", "--name-only"],
      ["diff", "--cached", "--name-only"],
      ["ls-files", "--others", "--exclude-standard"]
    ]);
    return { files: filterEligible(root, changed) };
  }

  if (!modulePath) return { files: [], error: "module_path_required" };
  const absoluteModule = path.resolve(root, String(modulePath));
  if (!isWithin(root, absoluteModule)) return { files: [], error: "module_outside_root" };
  if (existsSync(absoluteModule) && isMutationEligible(absoluteModule)) return { files: [absoluteModule] };
  const relative = toPosix(path.relative(root, absoluteModule)) || ".";
  const moduleFiles = await collectGitFiles(root, spawnCapture, [
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", relative]
  ]);
  return { files: filterEligible(root, moduleFiles) };
}

export function parseMutationReport(report, { root = ".", maxSurvivors = 100 } = {}) {
  if (!report || typeof report !== "object" || typeof report.files !== "object" || !report.files) {
    return { ok: false, error: "Mutation report must contain a files object." };
  }

  const statusCounts = {
    Killed: 0,
    Survived: 0,
    NoCoverage: 0,
    Timeout: 0,
    CompileError: 0,
    RuntimeError: 0,
    Ignored: 0,
    Pending: 0
  };
  const surviving = [];
  let total = 0;

  for (const [file, fileResult] of Object.entries(report.files)) {
    const mutants = Array.isArray(fileResult?.mutants) ? fileResult.mutants : [];
    for (const mutant of mutants) {
      total += 1;
      const status = String(mutant?.status || "Pending");
      if (Object.hasOwn(statusCounts, status)) statusCounts[status] += 1;
      if (status === "Survived" && surviving.length < maxSurvivors) {
        surviving.push(normalizeSurvivingMutant(file, mutant, root));
      }
    }
  }

  const detected = statusCounts.Killed + statusCounts.Timeout;
  const undetected = statusCounts.Survived + statusCounts.NoCoverage;
  const denominator = detected + undetected;
  const mutationScore = denominator > 0 ? roundPercent((detected / denominator) * 100) : null;

  return {
    ok: true,
    pending: statusCounts.Pending,
    telemetry: {
      mutants_total: total,
      killed: statusCounts.Killed,
      survived: statusCounts.Survived,
      timeout: statusCounts.Timeout,
      no_coverage: statusCounts.NoCoverage,
      mutation_score: mutationScore,
      compile_error: statusCounts.CompileError,
      runtime_error: statusCounts.RuntimeError,
      ignored: statusCounts.Ignored,
      pending: statusCounts.Pending
    },
    surviving_mutants: surviving
  };
}

export function survivingMutantToCandidate(mutant, signals = {}, mutationScore = null, priorityScale = 1) {
  const fingerprint = stableFingerprint({
    source: "stryker",
    path: mutant.path,
    id: mutant.id,
    mutator: mutant.mutator,
    location: mutant.location
  });
  const survivedCount = Math.max(1, Number(signals.survived_mutant_count || 1));
  const changeFrequency = Math.max(0, Number(signals.source_change_frequency || 0));
  const blastRadius = Math.max(0, Number(signals.blast_radius || 0));
  const prioritySignal = survivedCount * Math.max(1, changeFrequency) * Math.max(1, blastRadius);
  const startLine = positiveInteger(mutant?.location?.start?.line);
  const endLine = positiveInteger(mutant?.location?.end?.line) || startLine;
  const relatedTests = uniqueStrings(signals.related_tests, 30, 500);
  return {
    source: ["stryker"],
    fingerprint,
    category: "TEST_QUALITY",
    component: "mutation-testing",
    affected_paths: mutant.path ? [mutant.path] : [],
    evidence: {
      fingerprint,
      mutant_id: mutant.id,
      status: "Survived",
      mutator: mutant.mutator,
      location: mutant.location,
      replacement: mutant.replacement,
      production_path: true,
      survived_mutant_count: survivedCount,
      source_change_frequency: changeFrequency,
      blast_radius: blastRadius,
      priority_signal: prioritySignal,
      related_tests: relatedTests,
      reference_files: uniqueStrings(signals.reference_files, 30, 500),
      before_mutation_score: Number.isFinite(Number(mutationScore)) ? Number(mutationScore) : null,
      rerun: startLine && endLine ? {
        action: "mutation",
        mode: "module",
        module: mutant.path,
        range: { start_line: startLine, end_line: endLine }
      } : null
    },
    baseline: Number.isFinite(Number(mutationScore)) ? { mutation_score: Number(mutationScore) } : null,
    confidence: 0.98,
    impact: Math.max(0.1, Math.min(1, Number(priorityScale) || 0.1)),
    frequency: 1,
    estimated_cost: relatedTests.length ? 0.25 : 0.45,
    regression_probability: 1,
    estimated_benefit: "Inspect " + (relatedTests.length ? relatedTests.length : "related")
      + " test(s), strengthen coverage for surviving mutant " + mutant.id
      + ", then rerun its exact mutation range."
  };
}

export function buildTestQualityCandidates(mutants = [], analysisByPath = {}, mutationScore = null) {
  const counts = new Map();
  for (const mutant of mutants) counts.set(mutant.path, (counts.get(mutant.path) || 0) + 1);
  const priorityByPath = new Map();
  let maxPriority = 1;
  for (const [sourcePath, count] of counts) {
    const signals = analysisByPath[sourcePath] || {};
    const raw = Math.max(1, count)
      * Math.max(1, Number(signals.source_change_frequency || 0))
      * Math.max(1, Number(signals.blast_radius || 0));
    priorityByPath.set(sourcePath, raw);
    maxPriority = Math.max(maxPriority, raw);
  }
  return mutants.map((mutant) => {
    const sourceSignals = analysisByPath[mutant.path] || {};
    const signals = {
      ...sourceSignals,
      survived_mutant_count: counts.get(mutant.path) || 1
    };
    const scale = (priorityByPath.get(mutant.path) || 1) / maxPriority;
    return survivingMutantToCandidate(mutant, signals, mutationScore, scale);
  });
}

export function formatMutationRange(file, range = {}) {
  const startLine = positiveInteger(range.start_line ?? range.startLine);
  const endLine = positiveInteger(range.end_line ?? range.endLine);
  if (!startLine || !endLine || endLine < startLine) throw new Error("Invalid mutation range.");
  return String(file) + ":" + startLine + "-" + endLine;
}

export function isMutationEligible(file) {
  const normalized = toPosix(String(file || ""));
  const ext = path.extname(normalized).toLowerCase();
  if (!ELIGIBLE_EXTENSIONS.has(ext)) return false;
  const base = path.basename(normalized).toLowerCase();
  if (base.endsWith(".d.ts") || /\.(?:test|spec)\.[^.]+$/i.test(base)) return false;
  if (/(?:^|\/)(?:__tests__|test|tests|node_modules|dist|build|coverage|\.stryker-tmp)(?:\/|$)/i.test(normalized)) return false;
  return true;
}

async function collectGitFiles(root, spawnCapture, commands) {
  const files = new Set();
  if (typeof spawnCapture !== "function") return [];
  for (const args of commands) {
    const result = await spawnCapture("git", args, root, 30_000);
    if (result?.exit_code !== 0) continue;
    for (const entry of String(result?.stdout || "").split(/\r?\n/).filter(Boolean)) {
      files.add(path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(root, entry));
    }
  }
  return [...files];
}

function filterEligible(root, files) {
  return [...new Set((files || [])
    .map((file) => path.resolve(file))
    .filter((file) => isWithin(root, file) && isMutationEligible(file)))]
    .sort();
}

function normalizeSurvivingMutant(file, mutant, root) {
  const rawPath = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
  return {
    path: toPosix(path.relative(root, rawPath)),
    id: String(mutant?.id || "").slice(0, 160),
    mutator: String(mutant?.mutatorName || "unknown").slice(0, 160),
    replacement: typeof mutant?.replacement === "string" ? mutant.replacement.slice(0, 300) : null,
    location: normalizeLocation(mutant?.location)
  };
}

function normalizeLocation(location) {
  return {
    start: {
      line: positiveInteger(location?.start?.line),
      column: positiveInteger(location?.start?.column)
    },
    end: {
      line: positiveInteger(location?.end?.line),
      column: positiveInteger(location?.end?.column)
    }
  };
}

function normalizeMode(value) {
  const mode = String(value || "changed").trim().toLowerCase();
  if (!["changed", "module", "full"].includes(mode)) throw new Error("Invalid mutation mode: " + mode);
  return mode;
}

function unavailableResult(mode, reason) {
  return {
    engine: "stryker",
    available: false,
    ok: false,
    gate: "unavailable",
    mode,
    reason,
    targets: [],
    telemetry: emptyTelemetry(),
    surviving_mutants: [],
    candidate_ingestion: { detected: 0, added: 0, existing: 0, total: 0 }
  };
}

function emptyTelemetry() {
  return {
    mutants_total: 0,
    killed: 0,
    survived: 0,
    timeout: 0,
    no_coverage: 0,
    mutation_score: null,
    duration_ms: 0
  };
}

async function fileStamp(file) {
  try {
    const info = await stat(file);
    return { exists: true, mtime_ms: Number(info.mtimeMs || 0), size: Number(info.size || 0) };
  } catch {
    return { exists: false, mtime_ms: 0, size: 0 };
  }
}

function changedStamp(before, after) {
  if (!before?.exists && after?.exists) return true;
  return Number(after?.mtime_ms || 0) !== Number(before?.mtime_ms || 0)
    || Number(after?.size || 0) !== Number(before?.size || 0);
}

function publicTargets(root, files) {
  return (files || []).map((file) => toPosix(path.relative(root, file)));
}

function matchesAnyCriticalPath(file, patterns) {
  return (patterns || []).some((pattern) => globToRegExp(String(pattern || "")).test(file));
}

function globToRegExp(pattern) {
  let source = "^";
  const normalized = toPosix(pattern);
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
  }
  return new RegExp(source + "$");
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function uniqueStrings(values, maxItems, maxChars) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().slice(0, maxChars)))]
    .slice(0, maxItems);
}

function toPosix(value) {
  return String(value || "").replaceAll("\\", "/");
}

function round(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function roundPercent(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}
