import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { readPathState, writeFileAtomic } from "./file-state.mjs";

const MAX_TEST_FILES = 500;
const MAX_CACHE_ENTRIES = 100;
const MAX_PLAN_CACHE_ENTRIES = 64;
const PLAN_MANIFESTS = [
  "package.json", "pubspec.yaml", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml",
  "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "tsconfig.json", "analysis_options.yaml"
];

export function createChangeAwareVerification(options) {
  const { getTestCommandsMerged, runGatedCommand, cachePathForRoot, readState = readPathState, now = () => Date.now() } = options;
  const planCache = new Map();

  async function plan(root, changedFiles) {
    const normalizedRoot = path.resolve(root);
    const files = normalizeChangedFiles(normalizedRoot, changedFiles);
    const inputFingerprint = await buildPlanInputFingerprint(normalizedRoot, files, readState);
    const planKey = `${normalizedRoot}\0${inputFingerprint}`;
    const cachedPlan = planCache.get(planKey);
    if (cachedPlan) {
      touchPlanCache(planKey, cachedPlan);
      return {
        ...cachedPlan,
        cache: await inspectCache(normalizedRoot, cachedPlan.fingerprint, cachedPlan.gates),
        prefetch: { cache_hit: true, input_fingerprint: inputFingerprint }
      };
    }

    const commands = await getTestCommandsMerged(normalizedRoot);
    const classification = classifyChanges(normalizedRoot, files);
    const impactedTests = await discoverImpactedTests(normalizedRoot, files);
    const runner = await detectTargetedRunner(normalizedRoot, commands);
    const targetedTestCommand = buildTargetedTestCommand(runner, impactedTests);
    const gates = [];

    if (!classification.docsOnly) {
      if (targetedTestCommand) {
        gates.push({ name: "targeted_test", command: targetedTestCommand, scope: "targeted", reason: `${impactedTests.length} relevant test file(s)` });
      } else if (classification.tests > 0 && commands.test) {
        gates.push({ name: "test", command: commands.test, scope: "package", reason: "changed test files but targeted runner syntax is not proven" });
      } else if (classification.source > 0 && commands.test && impactedTests.length === 0) {
        gates.push({ name: "test", command: commands.test, scope: "package", reason: "source changed without a confidently targeted test" });
      }
      if (classification.source > 0 && commands.typecheck) gates.push({ name: "typecheck", command: commands.typecheck, scope: "package", reason: "source files changed" });
      if (classification.source > 0 && commands.lint) gates.push({ name: "lint", command: commands.lint, scope: "package", reason: "source files changed" });
      if (classification.config > 0) {
        if (commands.typecheck && !gates.some((gate) => gate.name === "typecheck")) gates.push({ name: "typecheck", command: commands.typecheck, scope: "package", reason: "configuration changed" });
        if (commands.lint && !gates.some((gate) => gate.name === "lint")) gates.push({ name: "lint", command: commands.lint, scope: "package", reason: "configuration changed" });
        if (commands.build) gates.push({ name: "build", command: commands.build, scope: "package", reason: "configuration changed" });
        if (commands.test && !gates.some((gate) => gate.name === "test" || gate.name === "targeted_test")) gates.push({ name: "test", command: commands.test, scope: "package", reason: "configuration changed" });
      }
    }

    const fingerprint = await buildVerificationFingerprint(normalizedRoot, files, gates, readState);
    const cache = await inspectCache(normalizedRoot, fingerprint, gates);
    const strategy = classification.docsOnly ? "docs_only" : classification.config > 0 ? "config_escalated" : targetedTestCommand ? "targeted" : gates.length > 0 ? "package" : "none";
    const result = {
      root: normalizedRoot,
      strategy,
      changed_files: files.map((file) => path.relative(normalizedRoot, file) || path.basename(file)),
      classification,
      impacted_tests: impactedTests,
      runner,
      gates,
      fingerprint,
      cache,
      prefetch: { cache_hit: false, input_fingerprint: inputFingerprint },
      auto_run: false
    };
    planCache.set(planKey, result);
    trimPlanCache();
    return result;
  }

  async function execute(
    root,
    changedFiles,
    { fresh = false, timeoutMs = 120_000, stopOnFailure = true, parallel = false, maxConcurrency = 3 } = {}
  ) {
    const planned = await plan(root, changedFiles);
    const results = new Array(planned.gates.length);
    const pending = [];

    for (let index = 0; index < planned.gates.length; index += 1) {
      const gate = planned.gates[index];
      const reusable = !fresh ? planned.cache.entries.find((entry) => entry.command === gate.command && entry.reusable) : null;
      if (reusable) {
        results[index] = { name: gate.name, command: gate.command, ok: true, status: "cached", cached: true, verified_at: reusable.verified_at };
      } else {
        pending.push({ index, gate });
      }
    }

    const runGate = async ({ index, gate }) => {
      const result = await runGatedCommand(gate.command, planned.root, timeoutMs);
      results[index] = { name: gate.name, status: result.ok ? "pass" : "fail", cached: false, ...result };
      return results[index];
    };

    if (parallel && pending.length > 1) {
      let cursor = 0;
      const workers = Array.from({ length: Math.min(Math.max(1, maxConcurrency), pending.length) }, async () => {
        while (true) {
          const item = pending[cursor++];
          if (!item) return;
          await runGate(item);
        }
      });
      await Promise.all(workers);
    } else {
      for (const item of pending) {
        const result = await runGate(item);
        if (!result.ok && stopOnFailure) break;
      }
    }

    const completed = results.filter(Boolean);
    for (const entry of completed) {
      if (entry.status === "pass" && entry.cached === false) {
        const gate = planned.gates.find((candidate) => candidate.name === entry.name && candidate.command === entry.command);
        if (gate) await recordCacheSuccess(planned.root, planned.fingerprint, gate.command, gate.name);
      }
    }

    const failed = completed.filter((result) => result.ok === false);
    return {
      ...planned,
      executed: true,
      fresh,
      parallel: Boolean(parallel && pending.length > 1),
      max_concurrency: parallel ? Math.min(Math.max(1, maxConcurrency), Math.max(1, pending.length)) : 1,
      ok: failed.length === 0,
      ran: completed.filter((result) => result.status === "pass" || result.status === "fail").length,
      reused: completed.filter((result) => result.status === "cached").length,
      failed: failed.length,
      stopped_early: completed.length < planned.gates.length,
      results: completed
    };
  }

  async function inspectCache(root, fingerprint, gates) {
    const cache = await readCache(root);
    const entries = gates.map((gate) => {
      const hit = cache.entries.find((entry) => entry.key === cacheKey(fingerprint, gate.command) && entry.ok === true);
      return { name: gate.name, command: gate.command, reusable: Boolean(hit), ...(hit?.verified_at ? { verified_at: hit.verified_at } : {}) };
    });
    return { hits: entries.filter((entry) => entry.reusable).length, entries };
  }

  async function readCache(root) {
    const file = cachePathForRoot(root);
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries.slice(-MAX_CACHE_ENTRIES) : [] };
    } catch {
      return { version: 1, entries: [] };
    }
  }

  async function recordCacheSuccess(root, fingerprint, command, name) {
    const file = cachePathForRoot(root);
    const cache = await readCache(root);
    const key = cacheKey(fingerprint, command);
    const next = cache.entries.filter((entry) => entry.key !== key);
    next.push({ key, fingerprint, command, name, ok: true, verified_at: new Date(now()).toISOString() });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, Buffer.from(`${JSON.stringify({ version: 1, entries: next.slice(-MAX_CACHE_ENTRIES) }, null, 2)}\n`, "utf8"));
  }

  function touchPlanCache(key, value) {
    planCache.delete(key);
    planCache.set(key, value);
  }

  function trimPlanCache() {
    while (planCache.size > MAX_PLAN_CACHE_ENTRIES) {
      const oldest = planCache.keys().next().value;
      if (!oldest) break;
      planCache.delete(oldest);
    }
  }

  return { plan, execute, prefetch: plan, readCache, recordCacheSuccess };
}

export function classifyChanges(root, changedFiles) {
  let source = 0, tests = 0, config = 0, docs = 0, other = 0;
  for (const file of changedFiles) {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    if (isTestFile(relative)) tests += 1;
    else if (isConfigFile(relative)) config += 1;
    else if (isDocsFile(relative)) docs += 1;
    else if (isSourceFile(relative)) source += 1;
    else other += 1;
  }
  return { source, tests, config, docs, other, docsOnly: docs > 0 && source === 0 && tests === 0 && config === 0 && other === 0 };
}

export async function discoverImpactedTests(root, changedFiles) {
  const normalizedRoot = path.resolve(root);
  const changed = normalizeChangedFiles(normalizedRoot, changedFiles);
  const direct = new Set();
  const sourceStems = new Set();
  for (const absolute of changed) {
    const relative = path.relative(normalizedRoot, absolute).replaceAll("\\", "/");
    if (isTestFile(relative) && existsSync(absolute)) direct.add(relative);
    if (!isSourceFile(relative) || isTestFile(relative)) continue;
    const ext = path.extname(relative);
    const base = path.basename(relative, ext);
    sourceStems.add(base.toLowerCase());
    for (const candidate of directTestCandidates(relative)) if (existsSync(path.join(normalizedRoot, candidate))) direct.add(candidate);
  }
  const allTests = await collectTestFiles(normalizedRoot, MAX_TEST_FILES);
  for (const testFile of allTests) {
    if (direct.size >= 40) break;
    const normalized = testFile.toLowerCase();
    if ([...sourceStems].some((stem) => normalized.includes(stem))) direct.add(testFile);
  }
  return [...direct].sort().slice(0, 40);
}

export async function buildVerificationFingerprint(root, changedFiles, gates, readState = readPathState) {
  const hash = createHash("sha256");
  hash.update(path.resolve(root));
  const files = normalizeChangedFiles(root, changedFiles).sort();
  for (const file of files) {
    let state;
    try { state = await readState(file); } catch { state = null; }
    hash.update("\0file\0");
    hash.update(path.relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(state?.exists ? (state.sha256 || `size:${state.size ?? 0}`) : "missing");
  }
  for (const gate of gates) {
    hash.update("\0gate\0");
    hash.update(String(gate.name));
    hash.update("\0");
    hash.update(String(gate.command));
  }
  return hash.digest("hex");
}

export async function buildPlanInputFingerprint(root, changedFiles, readState = readPathState) {
  const normalizedRoot = path.resolve(root);
  const hash = createHash("sha256");
  hash.update(normalizedRoot);
  const files = normalizeChangedFiles(normalizedRoot, changedFiles).sort();
  const dependencies = [...files, ...PLAN_MANIFESTS.map((name) => path.join(normalizedRoot, name))];
  const seen = new Set();
  for (const file of dependencies) {
    const absolute = path.resolve(file);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    let state;
    try { state = await readState(absolute); } catch { state = null; }
    hash.update("\0input\0");
    hash.update(path.relative(normalizedRoot, absolute).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(state?.exists ? (state.sha256 || `size:${state.size ?? 0}`) : "missing");
  }
  return hash.digest("hex");
}

async function detectTargetedRunner(root, commands) {
  if (existsSync(path.join(root, "pubspec.yaml")) && commands.test?.startsWith("flutter test")) return { kind: "flutter", safe_targeted: true };
  if (commands.test?.includes("pytest")) return { kind: "pytest", safe_targeted: true };
  try {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const script = String(pkg?.scripts?.test || "");
    if (/\bvitest\b/.test(script)) return { kind: "vitest", safe_targeted: true };
    if (/\bjest\b/.test(script)) return { kind: "jest", safe_targeted: true };
    if (/\b(?:node|tsx)\s+--test\b/.test(script)) return { kind: "node-test", safe_targeted: true };
    if (script) return { kind: "npm-unknown", safe_targeted: false };
  } catch {}
  return { kind: "unknown", safe_targeted: false };
}

function buildTargetedTestCommand(runner, tests) {
  if (!runner.safe_targeted || tests.length === 0) return null;
  const files = tests.map(shellQuote).join(" ");
  if (runner.kind === "flutter") return `flutter test ${files}`;
  if (runner.kind === "pytest") return `python -m pytest ${files}`;
  if (runner.kind === "vitest" || runner.kind === "jest" || runner.kind === "node-test") return `npm test -- ${files}`;
  return null;
}

function directTestCandidates(relative) {
  const normalized = relative.replaceAll("\\", "/");
  const ext = path.posix.extname(normalized);
  const dir = path.posix.dirname(normalized);
  const base = path.posix.basename(normalized, ext);
  const candidates = [path.posix.join(dir, `${base}.test${ext}`), path.posix.join(dir, `${base}.spec${ext}`), path.posix.join(dir, "__tests__", `${base}.test${ext}`), path.posix.join(dir, "__tests__", `${base}.spec${ext}`)];
  if (ext === ".dart") candidates.push(path.posix.join("test", `${base}_test.dart`));
  if (ext === ".py") candidates.push(path.posix.join("tests", `test_${base}.py`), path.posix.join("tests", `${base}_test.py`));
  return candidates;
}

async function collectTestFiles(root, limit) {
  const result = [];
  async function walk(dir, depth) {
    if (depth > 7 || result.length >= limit) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (result.length >= limit) return;
      if ([".git", "node_modules", "dist", "build", ".dart_tool", ".gradle"].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relativeEntry = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory() && isGeneratedVerificationDir(relativeEntry)) continue;
      if (entry.isDirectory()) await walk(absolute, depth + 1);
      else {
        const relative = path.relative(root, absolute).replaceAll("\\", "/");
        if (isTestFile(relative)) result.push(relative);
      }
    }
  }
  await walk(root, 0);
  return result.sort();
}

function normalizeChangedFiles(root, changedFiles) {
  return [...new Set((changedFiles || []).filter(Boolean).map((file) => path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file)))];
}

function isGeneratedVerificationDir(relative) {
  const normalized = String(relative || "").replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === "data/workspaces" || normalized.startsWith("data/workspaces/") || normalized === "data/worktrees" || normalized.startsWith("data/worktrees/");
}
function isSourceFile(file) { return /\.(?:dart|java|[cm]?[jt]sx?|py|go|rs|cs)$/i.test(file); }
function isTestFile(file) { return /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|$)/i.test(file) || /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i.test(file) || /_test\.(?:dart|py|go|rs)$/i.test(file) || /(?:^|\/)test_.*\.py$/i.test(file); }
function isDocsFile(file) { const base = path.posix.basename(file); return /\.(?:md|mdx|rst)$/i.test(file) || /^(?:readme|changelog|contributing|architecture)(?:\.|$)/i.test(base) || file.startsWith("docs/"); }
function isConfigFile(file) { const base = path.posix.basename(file); return /^(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pubspec\.yaml|pubspec\.lock|analysis_options\.yaml|tsconfig.*\.json|jsconfig\.json|pyproject\.toml|go\.mod|cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|dockerfile|docker-compose.*\.ya?ml|\.eslintrc.*|eslint\.config\..*|\.prettierrc.*)$/i.test(base) || file.startsWith(".github/workflows/"); }
function cacheKey(fingerprint, command) { return createHash("sha256").update(`${fingerprint}\0${command}`).digest("hex"); }
function shellQuote(value) { const text = String(value); if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`; return `'${text.replace(/'/g, `'\\''`)}'`; }
