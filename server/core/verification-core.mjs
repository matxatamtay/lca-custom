import path from "node:path";

export function createVerificationCore(options) {
  const {
    ALLOWED_ORIGINS, AUTH_TOKEN, PRODUCT_TIER, RG_BIN, ROOTS, VERSION, collectImportantFiles,
    compactGitStatus, detectProjectProfile, getTestCommandsMerged, isoNow, resolvePath,
    runGatedCommand, toRel, resolveActiveProjectRoot, getRuntimeRecoveryMetrics
  } = options;

  async function collectWorkspaceDoctor(rootDir) {
    const [profile, git, importantFiles] = await Promise.all([
      detectProjectProfile(rootDir).catch(() => ({ languages: [], frameworks: [], packageManagers: [], manifests: [], scripts: {} })),
      compactGitStatus(rootDir),
      collectImportantFiles(rootDir).catch(() => [])
    ]);
    const checks = [];
    const add = (id, status, title, detail, recommendation) => checks.push({ id, status, title, detail, recommendation });

    add("version", "pass", "Version", `Local Coding Agent ${VERSION} (${PRODUCT_TIER})`, null);
    add("roots", ROOTS.length ? "pass" : "fail", "Workspace roots", `${ROOTS.length} root(s) configured`, ROOTS.length ? null : "Set AGENT_WORKSPACE to the repository you want to work on.");
    add("auth", AUTH_TOKEN ? "pass" : "warn", "MCP auth", AUTH_TOKEN ? "Bearer auth enabled" : "MCP_AUTH_TOKEN is not set", AUTH_TOKEN ? null : "Set MCP_AUTH_TOKEN if exposing beyond the private OpenAI tunnel/local loopback.");
    add("origin", ALLOWED_ORIGINS.size ? "warn" : "pass", "Browser Origin policy", ALLOWED_ORIGINS.size ? `${ALLOWED_ORIGINS.size} browser origin(s) allowed` : "Browser-origin MCP calls blocked by default", ALLOWED_ORIGINS.size ? "Keep MCP_ALLOWED_ORIGINS as narrow as possible." : null);
    add("rg", RG_BIN ? "pass" : "warn", "ripgrep", RG_BIN ? `Found: ${RG_BIN}` : "ripgrep not found; search_text falls back to slower scanning", RG_BIN ? null : "Install ripgrep for faster searches on large repos.");
    add("git", git.is_git_repo ? "pass" : "warn", "Git repository", git.is_git_repo ? `${git.clean ? "clean" : `${git.count} changed file(s)`} on ${git.branch || "unknown branch"}` : "Not a git repo or git unavailable", git.is_git_repo ? (git.count > 0 ? "Review current changes before large edits." : null) : "Initialize git or run from the repository root for better change tracking.");
    add("profile", (profile.languages || []).length ? "pass" : "warn", "Project profile", (profile.languages || []).length ? `Detected ${(profile.languages || []).join(", ")} at ${profile.projectRoot || rootDir}` : "No language/framework detected", (profile.languages || []).length ? null : "Add standard manifests or verify AGENT_WORKSPACE points at the repo root.");
    if ((profile.languages || []).includes("dart")) {
      const dart = profile.toolchains?.dart;
      add("dart_toolchain", dart?.executable ? "pass" : "warn", "Dart toolchain", dart?.executable ? `${dart.executable} (${dart.source || "detected"})` : (dart?.reason || "Dart SDK not found"), dart?.executable ? null : "Configure DART_BIN/FLUTTER_ROOT/FVM cache, or add a project .fvm/flutter_sdk.");
    }
    const hasReadme = importantFiles.some((f) => /^README/i.test(path.basename(f.path)));
    const hasSecurityDoc = importantFiles.some((f) => /^security\.md$/i.test(path.basename(f.path)));
    add("docs", hasReadme ? "pass" : "warn", "README", "README presence checked", hasReadme ? null : "Add a README so agents and contributors understand the repo quickly.");
    add("security_doc", hasSecurityDoc ? "pass" : "warn", "Security docs", "SECURITY.md presence checked", hasSecurityDoc ? null : "Add SECURITY.md for MCP/local-command safety expectations.");

    const fail = checks.filter((c) => c.status === "fail").length;
    const warn = checks.filter((c) => c.status === "warn").length;
    const score = Math.max(0, Math.min(100, 100 - fail * 25 - warn * 6));
    const status = fail ? "fail" : warn ? "warn" : "pass";
    return {
      status,
      score,
      root: toRel(rootDir),
      version: VERSION,
      tier: PRODUCT_TIER,
      checks,
      summary: { pass: checks.filter((c) => c.status === "pass").length, warn, fail },
      profile,
      git,
      runtime_recovery: getRuntimeRecoveryMetrics?.() ?? null,
      important_files: importantFiles.slice(0, 80),
      recommendations: checks.filter((c) => c.recommendation).map((c) => ({ id: c.id, recommendation: c.recommendation })).slice(0, 10)
    };
  }

  function normalizeGatePlan(include, commands) {
    const wanted = include?.length ? include : ["lint", "typecheck", "test", "build"];
    const allowed = new Set(["lint", "typecheck", "test", "build"]);
    return wanted
      .filter((name) => allowed.has(name))
      .map((name) => ({ name, command: commands?.[name] || null }));
  }

  async function runQualityGate({ cwd = ".", include, timeout_ms = 120_000, stop_on_failure = true, dry_run = false }) {
    const requestedRoot = resolvePath(cwd);
    const rootDir = resolveActiveProjectRoot
      ? (await resolveActiveProjectRoot({ workspaceRoot: requestedRoot, requestedRoot })).root
      : requestedRoot;
    const commands = await getTestCommandsMerged(rootDir);
    const plan = normalizeGatePlan(include, commands);
    const started = Date.now();
    const gates = [];
    if (dry_run) {
      return { ok: true, dry_run: true, root: toRel(rootDir), plan, commands, duration_ms: 0 };
    }
    for (const gate of plan) {
      if (!gate.command) {
        gates.push({ name: gate.name, status: "skipped", ok: true, reason: "command not detected" });
        continue;
      }
      const result = await runGatedCommand(gate.command, rootDir, timeout_ms);
      const entry = { name: gate.name, status: result.ok ? "pass" : "fail", ...result };
      gates.push(entry);
      if (!result.ok && stop_on_failure) break;
    }
    const failed = gates.filter((g) => g.status === "fail");
    const ran = gates.filter((g) => g.status === "pass" || g.status === "fail");
    return {
      ok: failed.length === 0,
      root: toRel(rootDir),
      commands,
      gates,
      ran: ran.length,
      skipped: gates.filter((g) => g.status === "skipped").length,
      failed: failed.length,
      duration_ms: Date.now() - started
    };
  }

  async function buildSessionReport(rootDir) {
    const [doctor, git] = await Promise.all([
      collectWorkspaceDoctor(rootDir),
      compactGitStatus(rootDir)
    ]);
    return {
      kind: "session_report",
      version: VERSION,
      tier: PRODUCT_TIER,
      ts: isoNow(),
      root: toRel(rootDir),
      git,
      doctor: {
        status: doctor.status,
        score: doctor.score,
        summary: doctor.summary,
        recommendations: doctor.recommendations
      }
    };
  }

  function recommendedReads({ importantFiles = [], treeEntries = [] }) {
    const picked = [];
    const add = (file, reason) => {
      if (!file || picked.some((item) => item.path === file)) return;
      picked.push({ path: file, reason });
    };
    for (const item of importantFiles) {
      const base = path.basename(item.path).toLowerCase();
      if (base.startsWith("readme")) add(item.path, "project overview");
      else if (base === "agents.md") add(item.path, "agent/project conventions");
      else if (base === "package.json") add(item.path, "scripts and dependencies");
      else if (base === "pyproject.toml" || base === "go.mod" || base === "cargo.toml" || base.endsWith(".csproj") || base.endsWith(".sln")) add(item.path, "main project manifest");
    }
    for (const entry of treeEntries) {
      if (picked.length >= 8) break;
      const normalized = entry.split(path.sep).join("/");
      if (/^(src|app|lib|server)\/(index|main|app|server)\.(js|ts|tsx|jsx|mjs|py|cs)$/.test(normalized)) {
        add(entry, "likely entrypoint");
      }
    }
    return picked.slice(0, 8);
  }

  function isSourceFile(file) {
    return /\.(js|ts|mjs|cjs|jsx|tsx|py|cs|go|rs|java)$/i.test(file) && !isTestFile(file);
  }

  function isTestFile(file) {
    return /(^|\/)(__tests__|tests?|spec)\//i.test(file) || /\.(test|spec)\.(js|ts|mjs|cjs|jsx|tsx)$/i.test(file) || /(^|\/)test_.*\.py$/i.test(file) || /_test\.(py|go|rs)$/i.test(file);
  }

  function isConfigFile(file) {
    return /(^|\/)(package\.json|tsconfig.*\.json|pyproject\.toml|go\.mod|cargo\.toml|.*\.csproj|.*\.sln|dockerfile|docker-compose.*\.ya?ml|\.github\/workflows\/.*\.ya?ml)$/i.test(file);
  }

  function parseDiffSummary(diff) {
    const files = new Map();
    let current = null;
    let newLine = 0;
    for (const line of diff.split(/\r?\n/)) {
      if (line.startsWith("+++ ")) {
        const file = line.slice(4).replace(/^b\//, "").trim();
        if (file === "/dev/null") {
          current = null;
        } else {
          current = files.get(file) || { path: file, added: 0, deleted: 0 };
          files.set(file, current);
        }
        continue;
      }
      if (line.startsWith("@@ ")) {
        const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
        newLine = match ? Number(match[1]) - 1 : 0;
        continue;
      }
      if (!current) continue;
      if (line.startsWith("+") && !line.startsWith("+++")) {
        newLine++;
        current.added++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        current.deleted++;
      } else if (!line.startsWith("\\")) {
        newLine++;
      }
    }
    const changed = [...files.values()];
    return {
      changed_files: changed.length,
      source_files: changed.filter((f) => isSourceFile(f.path)).length,
      test_files: changed.filter((f) => isTestFile(f.path)).length,
      config_files: changed.filter((f) => isConfigFile(f.path)).length,
      added_lines: changed.reduce((sum, f) => sum + f.added, 0),
      deleted_lines: changed.reduce((sum, f) => sum + f.deleted, 0),
      files: changed.slice(0, 80)
    };
  }

  function analyzeDiff(diff) {
    const findings = [];
    const summary = parseDiffSummary(diff);
    let currentFile = null;
    let lineNum = 0;
    let addedStreak = 0;
    let streakStart = 0;
    const secretPatterns = [
      { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
      { name: "github token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
      { name: "slack token", re: /xox[baprs]-[0-9A-Za-z-]{20,}/ },
      { name: "api key assignment", re: /\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*['"][^'"]{10,}['"]/i }
    ];
    const addFinding = (priority, loc, issue) => {
      if (findings.length < 150) findings.push({ priority, loc, issue });
    };

    for (const line of diff.split(/\r?\n/)) {
      if (line.startsWith("+++ ")) {
        currentFile = line.slice(4).replace(/^b\//, "").trim();
        addedStreak = 0;
        streakStart = 0;
        continue;
      }
      if (line.startsWith("@@ ")) {
        const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
        lineNum = match ? Number(match[1]) - 1 : 0;
        addedStreak = 0;
        streakStart = 0;
        continue;
      }
      if (line.startsWith("+") && !line.startsWith("+++")) {
        lineNum++;
        addedStreak++;
        if (addedStreak === 1) streakStart = lineNum;
        const added = line.slice(1);
        const loc = `${currentFile}:${lineNum}`;
        for (const pattern of secretPatterns) {
          if (pattern.re.test(added)) addFinding("P1", loc, `Secret-like ${pattern.name} added`);
        }
        if (/\beval\s*\(/.test(added)) addFinding("P1", loc, "eval() usage; potential code injection");
        if (/\binnerHTML\s*=/.test(added)) addFinding("P1", loc, "innerHTML assignment; potential XSS");
        if (/dangerouslySetInnerHTML/.test(added)) addFinding("P1", loc, "dangerouslySetInnerHTML; XSS risk");
        if (/\bchild_process\.exec\s*\(/.test(added) || /\brequire\(['"]child_process['"]\)/.test(added)) addFinding("P1", loc, "child_process exec; command injection risk");
        if (/\b(subprocess\.(Popen|run|call)|os\.system)\s*\(/.test(added)) addFinding("P2", loc, "Process execution added; verify arguments are trusted");
        if (/\bconsole\.(log|debug|info)\s*\(/.test(added)) addFinding("P2", loc, "console.log/debug left in code");
        if (/\bdebugger\b/.test(added)) addFinding("P2", loc, "debugger statement");
        const todo = added.match(/\b(TODO|FIXME|HACK)\b/);
        if (todo) addFinding(todo[1].toUpperCase() === "HACK" ? "P3" : "P2", loc, `${todo[1]} comment added`);
        if (addedStreak === 101) addFinding("P3", `${currentFile}:~${streakStart}`, "Very large added block (>100 lines); consider splitting");
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        // Deleted lines do not advance the new-file line counter.
      } else if (!line.startsWith("\\")) {
        lineNum++;
        addedStreak = 0;
      }
    }

    if (summary.source_files > 0 && summary.test_files === 0) {
      const firstSource = summary.files.find((file) => isSourceFile(file.path));
      if (firstSource) addFinding("P3", firstSource.path, "Source file changed without a corresponding test file change");
    }
    return { summary, findings };
  }


  return { analyzeDiff, buildSessionReport, collectWorkspaceDoctor, recommendedReads, runQualityGate };
}
