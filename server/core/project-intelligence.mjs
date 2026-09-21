import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { resolveActiveProjectRoot } from "./project-root-discovery.mjs";

export function createProjectIntelligence(options) {
  const { DEFAULT_CMD_TIMEOUT, SKIP_DIRS, parsePorcelain, spawnCapture, toRel } = options;

  async function detectProjectProfile(rootDir) {
    const requestedRoot = path.resolve(rootDir);
    const discovery = await resolveActiveProjectRoot({ workspaceRoot: requestedRoot, requestedRoot });
    rootDir = discovery.root;
    const profile = {
      languages: [], frameworks: [], packageManagers: [], scripts: {}, manifests: [],
      requestedRoot,
      projectRoot: rootDir,
      discoveryReason: discovery.reason,
      projects: discovery.candidates.map((candidate) => ({ root: candidate.root, manifests: candidate.manifests, depth: candidate.depth }))
    };

    async function tryRead(rel) {
      try {
        return await readFile(path.join(rootDir, rel), "utf8");
      } catch {
        return null;
      }
    }

    // Node / JavaScript / TypeScript
    const pkgJson = await tryRead("package.json");
    if (pkgJson) {
      profile.manifests.push("package.json");
      try {
        const pkg = JSON.parse(pkgJson);
        profile.languages.push("javascript");
        profile.packageManagers.push("npm");
        if (existsSync(path.join(rootDir, "yarn.lock"))) profile.packageManagers.push("yarn");
        if (existsSync(path.join(rootDir, "pnpm-lock.yaml"))) profile.packageManagers.push("pnpm");
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps["typescript"] || existsSync(path.join(rootDir, "tsconfig.json"))) profile.languages.push("typescript");
        if (deps["react"] || deps["react-dom"]) profile.frameworks.push("react");
        if (deps["next"]) profile.frameworks.push("next.js");
        if (deps["express"]) profile.frameworks.push("express");
        if (deps["@nestjs/core"]) profile.frameworks.push("nestjs");
        if (deps["vite"]) profile.frameworks.push("vite");
        if (deps["vue"]) profile.frameworks.push("vue");
        if (deps["svelte"]) profile.frameworks.push("svelte");
        if (pkg.scripts) profile.scripts = pkg.scripts;
      } catch {
        // invalid json
      }
    }

    // Flutter / Dart
    const pubspec = await tryRead("pubspec.yaml");
    if (pubspec) {
      profile.manifests.push("pubspec.yaml");
      profile.languages.push("dart");
      profile.frameworks.push("flutter");
      profile.packageManagers.push("pub");
    }

    // Python
    const reqTxt = await tryRead("requirements.txt");
    const pyproject = await tryRead("pyproject.toml");
    if (reqTxt || pyproject) {
      profile.languages.push("python");
      if (pyproject) {
        profile.manifests.push("pyproject.toml");
        profile.packageManagers.push("pip");
        if (pyproject.includes("[tool.poetry]")) profile.packageManagers.push("poetry");
        if (pyproject.includes("[tool.rye]")) profile.packageManagers.push("rye");
      }
      if (reqTxt) {
        profile.manifests.push("requirements.txt");
        if (!profile.packageManagers.includes("pip")) profile.packageManagers.push("pip");
      }
      const hasTests = existsSync(path.join(rootDir, "pytest.ini")) || existsSync(path.join(rootDir, "setup.cfg"));
      if (hasTests) profile.frameworks.push("pytest");
    }

    // Go
    const goMod = await tryRead("go.mod");
    if (goMod) {
      profile.manifests.push("go.mod");
      profile.languages.push("go");
      profile.packageManagers.push("go modules");
    }

    // Rust
    const cargoToml = await tryRead("Cargo.toml");
    if (cargoToml) {
      profile.manifests.push("Cargo.toml");
      profile.languages.push("rust");
      profile.packageManagers.push("cargo");
    }

    // .NET
    let items;
    try {
      items = await readdir(rootDir);
    } catch {
      items = [];
    }
    const csproj = items.find((f) => f.endsWith(".csproj"));
    const sln = items.find((f) => f.endsWith(".sln"));
    if (csproj || sln) {
      if (csproj) profile.manifests.push(csproj);
      if (sln) profile.manifests.push(sln);
      profile.languages.push("csharp");
      profile.packageManagers.push("dotnet");
      profile.frameworks.push(".NET");
    }

    // Java / Gradle / Maven
    const pomXml = await tryRead("pom.xml");
    const buildGradle = await tryRead("build.gradle");
    if (pomXml) {
      profile.manifests.push("pom.xml");
      profile.languages.push("java");
      profile.packageManagers.push("maven");
    }
    if (buildGradle) {
      profile.manifests.push("build.gradle");
      if (!profile.languages.includes("java")) profile.languages.push("java");
      profile.packageManagers.push("gradle");
    }

    // Deduplicate
    profile.languages = [...new Set(profile.languages)];
    profile.frameworks = [...new Set(profile.frameworks)];
    profile.packageManagers = [...new Set(profile.packageManagers)];

    return profile;
  }

  // Scan source files for symbol definitions
  async function scanSymbols(rootDir, { maxFiles = 500, maxMatches = 2000, files: seededFiles = null } = {}) {
    const symbols = [];
    const files = [];
    const exts = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".cs"]);
    const preferredDirs = new Map([
      ["src", 0],
      ["app", 1],
      ["lib", 2],
      ["server", 3],
      ["scripts", 4],
      ["test", 5],
      ["tests", 5],
      ["evals", 6],
      ["skills", 7],
      ["experiments", 50]
    ]);

    const jsPatterns = [
      { re: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/, kind: "function" },
      { re: /^(?:export\s+)?class\s+(\w+)(?:\s|{)/, kind: "class" },
      { re: /^(?:export\s+)?const\s+(\w+)\s*=/, kind: "const" },
      { re: /^\s{0,4}(\w+)\s*\([^)]*\)\s*\{/, kind: "method" },
      { re: /router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)/, kind: "route" }
    ];
    const pyPatterns = [
      { re: /^def\s+(\w+)\s*\(/, kind: "function" },
      { re: /^class\s+(\w+)(?:\s|:)/, kind: "class" },
      { re: /^\s{4}def\s+(\w+)\s*\(/, kind: "method" }
    ];
    const csPatterns = [
      { re: /^\s*(?:public|private|protected|internal)?\s*(?:sealed\s+|partial\s+|static\s+)?(?:class|record|struct|interface)\s+(\w+)/, kind: "class" },
      { re: /^\s*(?:public|private|protected|internal)\s+(?:static\s+|async\s+)?[\w<>\[\],?\s]+\s+(\w+)\s*\(/, kind: "method" }
    ];

    function entryRank(entry) {
      if (!entry.isDirectory()) return 100;
      return preferredDirs.get(entry.name) ?? 20;
    }

    function symbolRank(symbol) {
      const rel = symbol.path.split(path.sep).join("/");
      const first = rel.split("/")[0] || "";
      const firstRank = preferredDirs.get(first) ?? 20;
      const depth = rel.split("/").length;
      const kindRank = { route: 0, function: 1, class: 2, const: 3, method: 4 }[symbol.kind] ?? 5;
      return firstRank * 1000 + depth * 20 + kindRank;
    }

    async function collectFiles(dir, depth) {
      if (depth > 6 || files.length >= maxFiles) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => entryRank(a) - entryRank(b) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        if (SKIP_DIRS.has(entry.name)) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await collectFiles(abs, depth + 1);
        } else if (exts.has(path.extname(entry.name).toLowerCase())) {
          files.push(abs);
        }
      }
    }

    if (Array.isArray(seededFiles) && seededFiles.length) {
      files.push(...seededFiles.map((f) => path.isAbsolute(f) ? f : path.resolve(rootDir, f)).filter((f) => exts.has(path.extname(f).toLowerCase())).slice(0, maxFiles));
    } else {
      await collectFiles(rootDir, 1);
    }

    for (const abs of files) {
      if (symbols.length >= maxMatches) break;
      let content;
      try {
        content = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      const ext = path.extname(abs).toLowerCase();
      const patterns = ext === ".py" ? pyPatterns : ext === ".cs" ? csPatterns : jsPatterns;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && symbols.length < maxMatches; i++) {
        for (const pattern of patterns) {
          const match = lines[i].match(pattern.re);
          if (!match) continue;
          let name = match[1];
          if (pattern.kind === "route") name = `${match[1].toUpperCase()} ${match[2]}`;
          if (name && name.length < 60) {
            symbols.push({ path: toRel(abs), line: i + 1, kind: pattern.kind, name });
            break;
          }
        }
      }
    }

    return symbols.sort((a, b) => symbolRank(a) - symbolRank(b) || a.path.localeCompare(b.path) || a.line - b.line);
  }

  async function collectImportantFiles(rootDir) {
    const IMPORTANT_GLOBS = [
      /^readme(\.\w+)?$/i,
      /^agents\.md$/i,
      /^package\.json$/i,
      /^package-lock\.json$/i,
      /^tsconfig.*\.json$/i,
      /^\.env\.example$/i,
      /^dockerfile$/i,
      /^docker-compose.*\.(yml|yaml)$/i,
      /^pubspec\.yaml$/i,
      /^makefile$/i,
      /^cargo\.toml$/i,
      /^go\.mod$/i,
      /^pyproject\.toml$/i,
      /^requirements.*\.txt$/i,
      /^\.eslintrc.*$/i,
      /^\.prettierrc.*$/i,
      /^\.gitignore$/i,
      /^changelog\.md$/i,
      /^security\.md$/i,
      /^license$/i,
      /^license\..*$/i
    ];
    const result = [];

    let rootItems;
    try {
      rootItems = await readdir(rootDir, { withFileTypes: true });
    } catch {
      rootItems = [];
    }
    for (const e of rootItems) {
      if (!e.isFile()) continue;
      if (IMPORTANT_GLOBS.some((re) => re.test(e.name))) {
        const abs = path.join(rootDir, e.name);
        try {
          const info = await stat(abs);
          result.push({ path: toRel(abs), size: info.size });
        } catch { /* skip */ }
      }
    }

    const ghDir = path.join(rootDir, ".github", "workflows");
    try {
      const wfItems = await readdir(ghDir, { withFileTypes: true });
      for (const e of wfItems) {
        if (e.isFile() && /\.(yml|yaml)$/i.test(e.name)) {
          const abs = path.join(ghDir, e.name);
          try {
            const info = await stat(abs);
            result.push({ path: toRel(abs), size: info.size });
          } catch { /* skip */ }
        }
      }
    } catch { /* no .github/workflows */ }

    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  async function compactGitStatus(rootDir) {
    const status = await spawnCapture("git", ["status", "--porcelain"], rootDir, DEFAULT_CMD_TIMEOUT);
    if (status.exit_code !== 0) {
      return {
        is_git_repo: false,
        clean: null,
        error: (status.stderr || "not a git repository").split(/\r?\n/)[0]
      };
    }
    const branchRes = await spawnCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"], rootDir, DEFAULT_CMD_TIMEOUT);
    const files = parsePorcelain(status.stdout || "");
    const counts = {};
    for (const f of files) {
      const key = `${f.index || " "}${f.worktree || " "}`.trim() || "changed";
      counts[key] = (counts[key] || 0) + 1;
    }
    return {
      is_git_repo: true,
      branch: (branchRes.stdout || "").trim() || null,
      clean: files.length === 0,
      count: files.length,
      counts,
      files: files.slice(0, 60)
    };
  }

  function recommendNextActions({ profile, git, truncated }) {
    const actions = [];
    if (git?.is_git_repo && git.count > 0) {
      actions.push("Review current changes with review_diff or git_diff before large edits.");
    }
    if (truncated) {
      actions.push("Call repo_map with a narrower path/depth if you need more tree detail.");
    }
    if ((profile?.languages || []).length) {
      actions.push(`Detected stack: ${(profile.languages || []).join(", ")}${profile.frameworks?.length ? ` / ${(profile.frameworks || []).join(", ")}` : ""}.`);
    }
    actions.push("Use recommended_reads with read_many to gather context in one call.");
    actions.push("Use search_text and repo_symbols before opening many files.");
    actions.push("Prefer apply_patch batches to keep MCP tunnel round-trips low.");
    return actions.slice(0, 6);
  }


  return { collectImportantFiles, compactGitStatus, detectProjectProfile, recommendNextActions, scanSymbols };
}

async function detectProfileToolchains(rootDir, languages) {
  const toolchains = {};
  if (languages.includes("javascript") || languages.includes("typescript")) {
    toolchains.node = { executable: process.execPath, version: process.version, source: "runtime" };
  }
  if (languages.includes("dart")) {
    const dart = await resolveDartForProfile(rootDir);
    toolchains.dart = dart
      ? { executable: dart.path, source: dart.source }
      : { executable: null, source: null, reason: "Dart SDK not found from project FVM, configured environment, common FVM caches, or PATH." };
  }
  if (languages.includes("java") && process.env.JAVA_HOME) {
    toolchains.java = { home: path.resolve(process.env.JAVA_HOME), source: "JAVA_HOME" };
  }
  return toolchains;
}

async function resolveDartForProfile(rootDir) {
  const executable = process.platform === "win32" ? "dart.exe" : "dart";
  const candidates = [];
  const add = (candidate, source) => { if (candidate) candidates.push({ path: path.resolve(candidate), source }); };
  add(process.env.DART_BIN, "DART_BIN");
  add(path.join(rootDir, ".fvm", "flutter_sdk", "bin", executable), "project .fvm/flutter_sdk");
  if (process.env.FLUTTER_ROOT) add(path.join(process.env.FLUTTER_ROOT, "bin", executable), "FLUTTER_ROOT");
  if (process.env.FVM_FLUTTER_ROOT) add(path.join(process.env.FVM_FLUTTER_ROOT, "bin", executable), "FVM_FLUTTER_ROOT");
  const version = await readFvmVersionForProfile(rootDir);
  const homes = [process.env.FVM_CACHE_PATH, process.env.FVM_HOME, path.join(os.homedir(), "fvm"), path.join(os.homedir(), ".fvm"), path.join(os.homedir(), ".cache", "fvm")].filter(Boolean);
  if (version) for (const home of homes) add(path.join(home, "versions", version, "bin", executable), `FVM cache (${version})`);
  for (const home of homes) add(path.join(home, "default", "bin", executable), "FVM default");
  for (const directory of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) add(path.join(directory, executable), "PATH");
  const seen = new Set();
  for (const candidate of candidates) {
    const key = process.platform === "win32" ? candidate.path.toLowerCase() : candidate.path;
    if (seen.has(key)) continue;
    seen.add(key);
    if (existsSync(candidate.path)) return candidate;
  }
  return null;
}

async function readFvmVersionForProfile(rootDir) {
  try {
    const value = JSON.parse(await readFile(path.join(rootDir, ".fvmrc"), "utf8"));
    if (typeof value?.flutter === "string" && value.flutter.trim()) return value.flutter.trim();
  } catch { /* fallback below */ }
  try {
    const raw = (await readFile(path.join(rootDir, ".fvm", "version"), "utf8")).trim();
    return raw || null;
  } catch { return null; }
}
