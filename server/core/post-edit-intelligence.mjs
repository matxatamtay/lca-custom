import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { readPathState } from "./file-state.mjs";

export function createPostEditIntelligence(options) {
  const {
    getNextApplicationRuntime,
    getTestCommandsMerged,
    resolveProjectRoot,
    runShellCommand,
    resolveFormatter = detectFormatter,
    readState = readPathState,
    changeAwareVerification
  } = options;

  async function analyze(changedPaths) {
    const files = [...new Set((changedPaths || []).filter(Boolean).map((value) => path.resolve(value)))];
    if (!files.length) return emptyResult();

    const groups = new Map();
    for (const file of files) {
      let root;
      try {
        root = path.resolve(await resolveProjectRoot(file));
      } catch {
        root = path.dirname(file);
      }
      const list = groups.get(root) || [];
      list.push(file);
      groups.set(root, list);
    }

    const roots = [];
    const fileStates = [];
    for (const [root, rootFiles] of groups) {
      const formatter = await runFormatter(root, rootFiles);
      const states = await Promise.all(rootFiles.map(async (file) => {
        try {
          const state = await readState(file);
          const compact = {
            path: file,
            exists: state.exists,
            kind: state.kind,
            ...(state.sha256 ? { sha256: state.sha256 } : {}),
            ...(state.size !== undefined ? { size: state.size } : {}),
            ...(state.eol ? { eol: state.eol } : {}),
            ...(state.bom ? { bom: true } : {})
          };
          fileStates.push(compact);
          return compact;
        } catch (error) {
          const compact = { path: file, exists: false, error: String(error?.message || error) };
          fileStates.push(compact);
          return compact;
        }
      }));
      const semantic = await collectSemantic(root, rootFiles);
      const verification = await buildVerificationPlan(root, rootFiles);
      try {
        const runtime = await getNextApplicationRuntime();
        runtime?.invalidateContext?.(root, rootFiles);
      } catch {
        // Cache invalidation/prewarm is an optimization and must never change edit success.
      }
      roots.push({ root, formatter, semantic, verification, files: states.map((state) => state.path) });
    }

    const semanticDiagnostics = roots.flatMap((entry) => entry.semantic.diagnostics || []);
    return {
      changed_files: fileStates,
      roots,
      summary: {
        files: files.length,
        roots: roots.length,
        formatted_roots: roots.filter((entry) => entry.formatter.status === "pass").length,
        semantic_errors: semanticDiagnostics.filter((item) => item.severity === "error").length,
        semantic_warnings: semanticDiagnostics.filter((item) => item.severity === "warning").length
      }
    };
  }

  async function runFormatter(root, files) {
    const existingFiles = files.filter((file) => existsSync(file));
    if (!existingFiles.length) return { status: "skipped", reason: "no existing files to format" };
    let formatter;
    try {
      formatter = await resolveFormatter(root, existingFiles);
    } catch (error) {
      return { status: "unavailable", reason: String(error?.message || error) };
    }
    if (!formatter?.command) return { status: "skipped", reason: formatter?.reason || "no configured/detected formatter" };
    try {
      const result = await runShellCommand(formatter.command, root, undefined, formatter.timeoutMs || 30_000);
      return {
        status: result.exit_code === 0 ? "pass" : "fail",
        engine: formatter.engine || null,
        command: formatter.displayCommand || formatter.command,
        exit_code: result.exit_code,
        timed_out: Boolean(result.timed_out),
        ...(result.exit_code === 0 ? {} : { error: String(result.stderr || result.stdout || "formatter failed").trim().slice(0, 1200) })
      };
    } catch (error) {
      return { status: "fail", engine: formatter.engine || null, error: String(error?.message || error) };
    }
  }

  async function collectSemantic(root, files) {
    try {
      const runtime = await getNextApplicationRuntime();
      const semantic = runtime?.application?.semantic;
      if (!semantic?.diagnostics) {
        return { status: "unavailable", available: false, fresh: false, diagnostics: [], reason: "semantic diagnostics are not exposed by this runtime" };
      }
      const relativeFiles = files.map((file) => {
        const rel = path.relative(root, file);
        return rel && !rel.startsWith("..") ? rel : file;
      });
      const result = await semantic.diagnostics(root, relativeFiles);
      const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics.slice(0, 100) : [];
      return {
        status: result.state || (result.available ? "ready" : "unavailable"),
        available: Boolean(result.available),
        fresh: result.fresh !== false,
        language: result.language || "unknown",
        engine: result.engine || null,
        diagnostics,
        counts: countDiagnostics(diagnostics),
        ...(result.reason ? { reason: result.reason } : {})
      };
    } catch (error) {
      return { status: "unavailable", available: false, fresh: false, diagnostics: [], reason: String(error?.message || error) };
    }
  }

  async function buildVerificationPlan(root, files) {
    try {
      if (changeAwareVerification?.plan) return await changeAwareVerification.plan(root, files);
      const commands = await getTestCommandsMerged(root);
      const sourceChanged = files.some(isSourceFile);
      const configChanged = files.some(isConfigFile);
      const suggested = [];
      if (sourceChanged && commands?.lint) suggested.push("lint");
      if (sourceChanged && commands?.typecheck) suggested.push("typecheck");
      if ((sourceChanged || files.some(isTestFile)) && commands?.test) suggested.push("test");
      if (configChanged && commands?.build) suggested.push("build");
      return { suggested_gates: [...new Set(suggested)], auto_run: false };
    } catch (error) {
      return { suggested_gates: [], auto_run: false, reason: String(error?.message || error) };
    }
  }

  return { analyze };
}

export async function detectFormatter(root, files, environment = process.env) {
  const relativeFiles = files.map((file) => path.relative(root, file)).filter((file) => file && !file.startsWith(".."));
  const jsFiles = relativeFiles.filter((file) => /\.(?:[cm]?[jt]sx?|json|css|scss|md|ya?ml)$/i.test(file));
  if (jsFiles.length) {
    const pkg = await readJson(path.join(root, "package.json"));
    const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
    const binary = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "prettier.cmd" : "prettier");
    if (deps.prettier && await canAccess(binary)) {
      const args = jsFiles.map(shellQuote).join(" ");
      return {
        engine: "prettier",
        command: `${shellQuote(binary)} --write ${args}`,
        displayCommand: `prettier --write ${jsFiles.join(" ")}`
      };
    }
  }

  const dartFiles = relativeFiles.filter((file) => file.endsWith(".dart"));
  if (dartFiles.length && await canAccess(path.join(root, "pubspec.yaml"))) {
    const dart = await resolveDartBinary(root, environment);
    if (dart) {
      return {
        engine: "dart-format",
        command: `${shellQuote(dart)} format ${dartFiles.map(shellQuote).join(" ")}`,
        displayCommand: `dart format ${dartFiles.join(" ")}`
      };
    }
  }

  return { command: null, reason: "no project-local/configured formatter detected for changed files" };
}

async function resolveDartBinary(root, environment) {
  const executable = process.platform === "win32" ? "dart.exe" : "dart";
  const candidates = [
    environment.DART_BIN,
    path.join(root, ".fvm", "flutter_sdk", "bin", executable),
    environment.FLUTTER_ROOT ? path.join(environment.FLUTTER_ROOT, "bin", executable) : null,
    environment.FVM_FLUTTER_ROOT ? path.join(environment.FVM_FLUTTER_ROOT, "bin", executable) : null
  ].filter(Boolean);
  for (const candidate of candidates) if (await canAccess(candidate)) return path.resolve(candidate);
  return null;
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

async function canAccess(file) {
  try { await access(file); return true; } catch { return false; }
}

function shellQuote(value) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function countDiagnostics(diagnostics) {
  const counts = { error: 0, warning: 0, suggestion: 0, message: 0 };
  for (const item of diagnostics) {
    if (item?.severity in counts) counts[item.severity] += 1;
  }
  return counts;
}

function isSourceFile(file) {
  return /\.(?:dart|java|[cm]?[jt]sx?|py|go|rs|cs)$/i.test(file) && !isTestFile(file);
}

function isTestFile(file) {
  return /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|$)/i.test(file)
    || /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i.test(file)
    || /_test\.(?:dart|py|go|rs)$/i.test(file);
}

function isConfigFile(file) {
  return /(?:^|\/)(?:package\.json|pubspec\.yaml|tsconfig.*\.json|pom\.xml|build\.gradle(?:\.kts)?|pyproject\.toml|go\.mod|cargo\.toml)$/i.test(file);
}

function emptyResult() {
  return { changed_files: [], roots: [], summary: { files: 0, roots: 0, formatted_roots: 0, semantic_errors: 0, semantic_warnings: 0 } };
}
