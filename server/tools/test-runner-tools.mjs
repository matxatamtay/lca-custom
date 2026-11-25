import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export function createTestRunnerToolRegistrar(options) {
  const {
    reg, jsonResult, detectProjectProfile, getTestCommandsMerged, resolvePath,
    runGatedCommand, runQualityGate, spawnCapture, DEFAULT_CMD_TIMEOUT,
    workspaceStateRegistry, projectRootForPath, changeAwareVerification,
    resolveActiveProjectRoot, semgrepScan, semgrepRules, mutationRun
  } = options;

  async function collectChangedFiles(rootDir) {
    const commands = [
      ["diff", "--name-only"],
      ["diff", "--cached", "--name-only"],
      ["ls-files", "--others", "--exclude-standard"]
    ];
    const files = new Set();
    for (const args of commands) {
      const result = await spawnCapture("git", args, rootDir, DEFAULT_CMD_TIMEOUT);
      if (result.exit_code !== 0) continue;
      for (const entry of String(result.stdout || "").split(/\r?\n/).filter(Boolean)) {
        files.add(path.resolve(rootDir, entry));
      }
    }
    return [...files];
  }

  async function resolveVerificationTarget(cwd, changedFiles) {
    const requestedRoot = resolvePath(cwd || ".");
    const files = [...new Set((changedFiles || []).filter(Boolean).map((file) =>
      path.isAbsolute(file) ? path.resolve(file) : path.resolve(requestedRoot, file)
    ))];
    if (!resolveActiveProjectRoot) return { root: requestedRoot, changedFiles: files };
    const workspaceRoot = projectRootForPath(requestedRoot);
    const resolution = await resolveActiveProjectRoot({
      workspaceRoot,
      requestedRoot,
      changedFiles: files
    });
    return { root: resolution.root || requestedRoot, changedFiles: files };
  }

  async function recordVerification(result, tool, cwd) {
    try {
      const root = projectRootForPath(resolvePath(cwd || "."));
      const state = workspaceStateRegistry?.forRoot?.(root);
      const task = await state?.taskState?.recordVerification(result, { tool });
      if (task) await state?.checkpoint?.refresh({ reason: `verification:${tool}` });
    } catch { /* verification result remains authoritative even if checkpoint persistence fails */ }
  }

  function registerTestRunnerTools(mcp) {
    reg(
      mcp,
      "quality_gate",
      {
        title: "Quality gate Pro",
        description: "Manual verification runner. Detects and runs lint/typecheck/test/build commands only when explicitly requested, with compact pass/fail summaries.",
        inputSchema: {
          cwd: z.string().optional(),
          include: z.array(z.enum(["lint", "typecheck", "test", "build"])).optional().describe("Gate order/subset. Default: lint,typecheck,test,build."),
          timeout_ms: z.number().int().min(1000).max(600000).optional(),
          stop_on_failure: z.boolean().optional(),
          dry_run: z.boolean().optional().describe("Return planned gates without executing.")
        }
      },
      async ({ cwd = ".", include, timeout_ms = 120_000, stop_on_failure = true, dry_run = false }) => {
        const result = await runQualityGate({ cwd, include, timeout_ms, stop_on_failure, dry_run });
        if (!dry_run) await recordVerification(result, "quality_gate", cwd);
        return jsonResult(result);
      }
    );

    reg(
      mcp,
      "detect_test_commands",
      {
        title: "Detect test commands",
        description: "Detect test/build/lint/dev commands from workspace manifests (package.json, go.mod, Cargo.toml, etc.).",
        inputSchema: { path: z.string().optional() }
      },
      async ({ path: rel = "." }) => {
        const rootDir = resolvePath(rel);
        const cmds = await getTestCommandsMerged(rootDir);
        const profile = await detectProjectProfile(rootDir);
        return jsonResult({ commands: cmds, languages: profile.languages, packageManagers: profile.packageManagers });
      }
    );

    reg(
      mcp,
      "run_tests",
      {
        title: "Run tests",
        description: "Run the detected (or provided) test command. Returns {ok, exit_code, summary, failures}.",
        inputSchema: {
          command: z.string().optional().describe("Override detected test command."),
          cwd: z.string().optional(),
          timeout_ms: z.number().int().min(1000).max(600000).optional()
        }
      },
      async ({ command, cwd = ".", timeout_ms = 120_000 }) => {
        const rootDir = resolvePath(cwd);
        let cmd = command;
        if (!cmd) {
          const cmds = await getTestCommandsMerged(rootDir);
          cmd = cmds.test;
          if (!cmd) throw new Error("Could not detect test command. Provide command explicitly.");
        }
        const res = await runGatedCommand(cmd, rootDir, timeout_ms);
        return jsonResult(res);
      }
    );

    reg(
      mcp,
      "run_build",
      {
        title: "Run build",
        description: "Run the detected (or provided) build command. Returns {ok, exit_code, summary, failures}.",
        inputSchema: {
          command: z.string().optional(),
          cwd: z.string().optional(),
          timeout_ms: z.number().int().min(1000).max(600000).optional()
        }
      },
      async ({ command, cwd = ".", timeout_ms = 120_000 }) => {
        const rootDir = resolvePath(cwd);
        let cmd = command;
        if (!cmd) {
          const cmds = await getTestCommandsMerged(rootDir);
          cmd = cmds.build;
          if (!cmd) throw new Error("Could not detect build command. Provide command explicitly.");
        }
        return jsonResult(await runGatedCommand(cmd, rootDir, timeout_ms));
      }
    );

    reg(
      mcp,
      "run_lint",
      {
        title: "Run lint",
        description: "Run the detected (or provided) lint command. Returns {ok, exit_code, summary, failures}.",
        inputSchema: {
          command: z.string().optional(),
          cwd: z.string().optional(),
          timeout_ms: z.number().int().min(1000).max(600000).optional()
        }
      },
      async ({ command, cwd = ".", timeout_ms = 60_000 }) => {
        const rootDir = resolvePath(cwd);
        let cmd = command;
        if (!cmd) {
          const cmds = await getTestCommandsMerged(rootDir);
          cmd = cmds.lint;
          if (!cmd) throw new Error("Could not detect lint command. Provide command explicitly.");
        }
        return jsonResult(await runGatedCommand(cmd, rootDir, timeout_ms));
      }
    );

    reg(
      mcp,
      "verify_changed",
      {
        title: "Verify changed files",
        description: "Plan or run the cheapest safe verification for changed files. Uses known runner semantics only, fingerprints inputs, and may reuse prior successful gates unless fresh=true.",
        inputSchema: {
          cwd: z.string().optional(),
          changed_files: z.array(z.string().min(1)).max(200).optional(),
          execute: z.boolean().optional().describe("Run the plan. Default false (plan only)."),
          fresh: z.boolean().optional().describe("Bypass reusable successful cache entries."),
          timeout_ms: z.number().int().min(1000).max(600000).optional(),
          stop_on_failure: z.boolean().optional().describe("Sequential mode only; parallel mode may already have started independent gates."),
          parallel: z.boolean().optional().describe("Run independent uncached gates concurrently. Default true when execute=true."),
          max_concurrency: z.number().int().min(1).max(4).optional()
        }
      },
      async ({ cwd = ".", changed_files, execute = false, fresh = false, timeout_ms = 120_000, stop_on_failure = true, parallel = true, max_concurrency = 3 }) => {
        if (!changeAwareVerification) throw new Error("Change-aware verification is unavailable.");
        const requestedRoot = resolvePath(cwd);
        const files = changed_files?.length ? changed_files : await collectChangedFiles(requestedRoot);
        const target = await resolveVerificationTarget(cwd, files);
        const result = execute
          ? await changeAwareVerification.execute(target.root, target.changedFiles, {
              fresh,
              timeoutMs: timeout_ms,
              stopOnFailure: stop_on_failure,
              parallel,
              maxConcurrency: max_concurrency
            })
          : await changeAwareVerification.plan(target.root, target.changedFiles);
        if (execute) await recordVerification(result, "verify_changed", target.root);
        return jsonResult(result);
      }
    );

    reg(
      mcp,
      "semgrep_scan",
      {
        title: "Semgrep regression scan",
        description: "Run local LCA Semgrep regression/invariant rules on demand. ERROR findings fail the gate, WARNING findings become self-improvement candidates, and INFO findings are telemetry only. Uses only local rule files and disables Semgrep metrics/version checks.",
        inputSchema: {
          cwd: z.string().optional().describe("Scan root. Defaults to the current workspace."),
          paths: z.array(z.string().min(1)).min(1).max(100).optional().describe("Optional explicit files/directories relative to cwd."),
          timeout_ms: z.number().int().min(1000).max(600000).optional(),
          max_results: z.number().int().min(1).max(1000).optional()
        }
      },
      async ({ cwd = ".", paths, timeout_ms = 120_000, max_results = 200 }) => {
        if (typeof semgrepScan !== "function") {
          return jsonResult({
            engine: "semgrep",
            available: false,
            ok: false,
            gate: "unavailable",
            reason: "semgrep_scanner_unavailable",
            findings: []
          });
        }
        const rootDir = resolvePath(cwd);
        const resolvedPaths = paths?.map((value) => path.isAbsolute(value)
          ? path.resolve(value)
          : path.resolve(rootDir, value));
        const result = await semgrepScan({
          root: rootDir,
          paths: resolvedPaths || [],
          timeoutMs: timeout_ms,
          maxResults: max_results
        });
        if (result.available !== false) await recordVerification(result, "semgrep_scan", rootDir);
        return jsonResult(result);
      }
    );

    reg(
      mcp,
      "semgrep_rules",
      {
        title: "Learned Semgrep rule lifecycle",
        description: "Manage per-workspace learned regression rules. Rules are always created as draft and can only advance draft→shadow→validated→blocking. Blocking promotion requires enough clean full scans, zero false-positive reports, a passing before/after fixture, and the current full scan to be clean.",
        inputSchema: {
          cwd: z.string().optional(),
          operation: z.enum(["list", "draft", "validate_fixture", "feedback", "promote"]).optional(),
          state: z.enum(["draft", "shadow", "validated", "blocking"]).optional(),
          id: z.string().min(1).max(180).optional(),
          to: z.enum(["shadow", "validated", "blocking"]).optional(),
          message: z.string().max(500).optional(),
          lang: z.string().min(1).max(40).optional(),
          pattern: z.string().max(20_000).optional(),
          pattern_regex: z.string().max(20_000).optional(),
          paths: z.array(z.string().min(1).max(500)).max(50).optional(),
          severity: z.enum(["ERROR", "WARNING", "INFO"]).optional(),
          category: z.string().max(80).optional(),
          component: z.string().max(160).optional(),
          before: z.string().max(20_000).optional(),
          after: z.string().max(20_000).optional(),
          false_positive: z.boolean().optional(),
          timeout_ms: z.number().int().min(1000).max(120000).optional()
        }
      },
      async (input) => {
        if (typeof semgrepRules !== "function") throw new Error("Regression rule lifecycle is unavailable.");
        return jsonResult(await semgrepRules(resolvePath(input.cwd || "."), input));
      }
    );

    reg(
      mcp,
      "mutation_test",
      {
        title: "Incremental mutation test",
        description: "Run local StrykerJS mutation testing on demand. Default mode mutates changed production JS/TS files incrementally; module and full modes are explicit. Surviving mutants become TEST_QUALITY candidates. A mutation-score threshold blocks only when both threshold and critical_paths are explicitly supplied and changed targets match those paths.",
        inputSchema: {
          cwd: z.string().optional(),
          mode: z.enum(["changed", "module", "full"]).optional(),
          module: z.string().max(4000).optional(),
          timeout_ms: z.number().int().min(1000).max(1800000).optional(),
          max_candidates: z.number().int().min(1).max(500).optional(),
          critical_paths: z.array(z.string().min(1).max(500)).max(50).optional(),
          threshold: z.number().min(0).max(100).optional(),
          range: z.object({
            start_line: z.number().int().min(1),
            end_line: z.number().int().min(1)
          }).optional().describe("Exact Stryker mutation range for mode=module, e.g. lines 73-74.")
        }
      },
      async ({ cwd = ".", mode = "changed", module, timeout_ms = 900_000, max_candidates = 100, critical_paths = [], threshold, range }) => {
        if (typeof mutationRun !== "function") {
          return jsonResult({
            engine: "stryker",
            available: false,
            ok: false,
            gate: "unavailable",
            mode,
            reason: "mutation_runner_unavailable"
          });
        }
        const requestedRoot = resolvePath(cwd);
        const workspaceRoot = projectRootForPath(requestedRoot);
        const resolution = resolveActiveProjectRoot
          ? await resolveActiveProjectRoot({ workspaceRoot, requestedRoot })
          : { root: requestedRoot };
        const rootDir = resolution.root || requestedRoot;
        const result = await mutationRun({
          root: rootDir,
          mode,
          module,
          timeoutMs: timeout_ms,
          maxCandidates: max_candidates,
          criticalPaths: critical_paths,
          threshold,
          range
        });
        if (result.available !== false) await recordVerification(result, "mutation_test", rootDir);
        return jsonResult(result);
      }
    );

    reg(
      mcp,
      "run_changed_tests",
      {
        title: "Run changed tests",
        description: "Run change-aware verification for git diff + untracked files. Explicit execution is fresh and never silently reuses a cached result.",
        inputSchema: {
          cwd: z.string().optional(),
          timeout_ms: z.number().int().min(1000).max(600000).optional()
        }
      },
      async ({ cwd = ".", timeout_ms = 120_000 }) => {
        if (!changeAwareVerification) throw new Error("Change-aware verification is unavailable.");
        const requestedRoot = resolvePath(cwd);
        const changedFiles = await collectChangedFiles(requestedRoot);
        const target = await resolveVerificationTarget(cwd, changedFiles);
        const result = await changeAwareVerification.execute(target.root, target.changedFiles, {
          fresh: true,
          timeoutMs: timeout_ms,
          stopOnFailure: false,
          parallel: true,
          maxConcurrency: 3
        });
        await recordVerification(result, "run_changed_tests", target.root);
        return jsonResult(result);
      }
    );
  }


  return registerTestRunnerTools;
}
