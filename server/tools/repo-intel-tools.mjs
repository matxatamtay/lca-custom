import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { composeTaskContext, compactTaskContextForModel } from "../core/context-composer.mjs";
import { buildAdaptiveWorkflow } from "../core/adaptive-workflow.mjs";
import { applyContextTuning, derivePerformanceTuning } from "../core/performance-autotuner.mjs";

export function createRepoIntelToolRegistrar(options) {
  const {
    reg, jsonResult, resolvePath, toRel, buildRepoIndex, collectImportantFiles,
    collectWorkspaceDoctor, detectProjectProfile, getNextApplicationRuntime, indexFresh,
    isoNow, readRepoIndex, recommendNextActions, recommendedReads, relEntriesToAbs,
    resolveTaskProjectRoot, scopedPrimaryRoot = () => undefined, resolveActiveProjectRoot, scanSymbols, writeRepoIndex, workspaceStateRegistry, projectRootForPath,
    changeAwareVerification, getPerformanceSnapshot, traceSpan,
    ALLOWED_ORIGINS, AUTH_TOKEN, MANIFEST_NAMES, PRIMARY_ROOT, PRODUCT_TIER,
    REPO_INDEX_TTL_MS, RG_BIN, ROOTS, VERSION
  } = options;

  function registerRepoIntelTools(mcp) {
    reg(
      mcp,
      "workspace_context",
      {
        title: "Workspace task context",
        description: "Build task context by always querying current filesystem search, native semantic analysis, CodeGraph, and AgentMemory in parallel. Use this first for coding tasks so semantic references, graph relationships, and prior project decisions are never skipped.",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
        inputSchema: {
          task: z.string().min(1).describe("Concrete coding task or question to investigate."),
          path: z.string().optional().describe("Project root or subdirectory. When omitted, a uniquely mentioned configured project in task is selected before falling back to the primary workspace root."),
          intent: z.enum(["understand", "debug", "implement", "refactor", "review"]).optional(),
          changed_files: z.array(z.string().min(1)).max(100).optional().describe("Known changed or relevant files to seed graph context."),
          max_items: z.number().int().min(3).max(100).optional().describe("Maximum evidence items returned. When omitted, a bounded workspace-specific default is derived from recent telemetry (normally 10)."),
          max_chars: z.number().int().min(1000).max(200000).optional().describe("Approximate context character budget. When omitted, a bounded workspace-specific default is derived from recent telemetry (normally 12000)."),
          output_detail: z.enum(["compact", "full"]).optional().describe("Default compact strips redundant ranking/debug metadata. Use full to inspect all provider diagnostics.")
        }
      },
      async ({ task, path: rel, intent, changed_files = [], max_items, max_chars, output_detail = "compact" }) => {
        const hasExplicitPath = typeof rel === "string" && rel.trim().length > 0;
        const rootDir = hasExplicitPath
          ? resolvePath(rel)
          : resolveTaskProjectRoot(task, ROOTS, scopedPrimaryRoot());
        let rootInfo;
        try {
          rootInfo = await stat(rootDir);
        } catch (error) {
          if (error?.code === "ENOENT") {
            throw new Error("Workspace root does not exist: " + rootDir);
          }
          throw error;
        }
        if (!rootInfo.isDirectory()) throw new Error("Workspace root is not a directory: " + rootDir);
        const workspaceRoot = projectRootForPath(rootDir);
        const performanceSnapshot = getPerformanceSnapshot?.() ?? null;
        const autotuning = derivePerformanceTuning(performanceSnapshot, workspaceRoot);
        const tunedBudget = applyContextTuning(autotuning, { maxItems: max_items, maxChars: max_chars });
        const effectiveMaxItems = tunedBudget.maxItems;
        const effectiveMaxChars = tunedBudget.maxChars;
        const activeProject = await resolveActiveProjectRoot({
          workspaceRoot,
          requestedRoot: rootDir,
          changedFiles: changed_files,
          task
        });
        const semanticChangedFiles = resolveContextChangedFiles(changed_files, {
          hasExplicitPath,
          rootDir,
          resolvePath
        });
        const runtime = await getNextApplicationRuntime();
        const context = await runtime.application.buildTaskContext.execute({
          task,
          root: activeProject.root,
          ...(intent ? { intent } : {}),
          ...(semanticChangedFiles.length ? { changedFiles: semanticChangedFiles } : {}),
          budget: { maxItems: effectiveMaxItems, maxChars: effectiveMaxChars }
        });
        context.project_resolution = {
          workspace_root: workspaceRoot,
          requested_root: rootDir,
          active_project_root: activeProject.root,
          reason: activeProject.reason,
          candidates: activeProject.candidates.slice(0, 20)
        };
        const state = workspaceStateRegistry?.forRoot?.(workspaceRoot);
        const [taskState, checkpoint] = await Promise.all([
          state?.taskState?.read?.().catch(() => null) ?? null,
          state?.checkpoint?.readCheckpoint?.().catch(() => null) ?? null
        ]);
        const composed = traceSpan
          ? await traceSpan("workspace_context.compose", () => composeTaskContext({
              context,
              taskState,
              checkpoint,
              requestChangedFiles: changed_files,
              maxItems: effectiveMaxItems,
              maxChars: effectiveMaxChars
            }))
          : composeTaskContext({
              context,
              taskState,
              checkpoint,
              requestChangedFiles: changed_files,
              maxItems: effectiveMaxItems,
              maxChars: effectiveMaxChars
            });
        const likelyReads = likelyReadHints(composed.evidence, semanticChangedFiles);
        let verificationHint = null;
        if (semanticChangedFiles.length && changeAwareVerification?.plan) {
          try {
            const plan = await changeAwareVerification.plan(activeProject.root, semanticChangedFiles);
            verificationHint = compactVerificationHint(plan);
          } catch {
            // Context remains authoritative even when optional verification planning fails.
          }
        }
        const workflow = buildAdaptiveWorkflow({
          task,
          intent,
          evidence: composed.evidence,
          coverage: composed.coverage,
          ranking: composed.ranking,
          likelyReads,
          verification: verificationHint,
          performance: performanceSnapshot,
          root: workspaceRoot
        });
        composed.execution_hints = {
          likely_reads: likelyReads,
          ...(verificationHint ? { verification: verificationHint } : {}),
          autotuning: compactAutotuningHint(autotuning, {
            max_items: effectiveMaxItems,
            max_chars: effectiveMaxChars,
            explicit_overrides: tunedBudget.explicit_overrides
          }),
          workflow,
          edit_strategy: likelyReads.length >= 2 || semanticChangedFiles.length >= 2
            ? "batch: use one workspace_edit action='batch' with operations for related edits; for multiple replacements in one file use action='replace' with replacements[]"
            : "prefer one transactional apply_patch for any related edits discovered together",
          patch_fusion: "apply_patch accepts verify='changed' to run the cheapest safe changed-file verification in the same call"
        };
        const coverage = composed.coverage;
        const summary = [
          `Context ready: ${composed.evidence.length} evidence item(s).`,
          `filesystem=${coverage.filesystem.hits}`,
          `Semantic=${coverage.semantic.status}:${coverage.semantic.hits}`,
          `CodeGraph=${coverage.codegraph.hits}`,
          `AgentMemory=${coverage.agentmemory.hits}`
        ].join(" ");
        const modelContext = output_detail === "full" ? composed : compactTaskContextForModel(composed);
        if (output_detail !== "full" && intent !== "understand" && intent !== "review" && effectiveMaxChars >= 6000) {
          const freeBudget = Math.max(500, effectiveMaxChars - Number(composed.composition?.budget?.used_chars || 0));
          const previews = await readContextSourcePreviews(activeProject.root, likelyReads, Math.min(2200, freeBudget));
          if (previews.length) {
            modelContext.execution_hints = { ...modelContext.execution_hints, source_previews: previews };
          }
        }
        return {
          structuredContent: modelContext,
          content: [{ type: "text", text: summary }]
        };
      }
    );

    reg(
      mcp,
      "workspace_doctor",
      {
        title: "Workspace doctor Pro",
        description: "PRO readiness check for the active workspace: roots, safety settings, auth/origin posture, git state, ripgrep, project profile, docs, score, and recommendations.",
        inputSchema: {
          path: z.string().optional().describe("Root dir to inspect (default: primary root).")
        }
      },
      async ({ path: rel = "." }) => {
        const rootDir = resolvePath(rel);
        return jsonResult(await collectWorkspaceDoctor(rootDir));
      }
    );

    reg(
      mcp,
      "workspace_snapshot",
      {
        title: "Workspace snapshot Pro",
        description: "PRO one-call briefing: roots, mode/policy, project profile, important files, compact tree, git status, ripgrep/cache status, recommended reads, and next actions. Use this FIRST to reduce MCP round-trips.",
        inputSchema: {
          path: z.string().optional().describe("Root dir to inspect (default: primary root)."),
          depth: z.number().int().min(1).max(5).optional().describe("Tree depth (default 3)."),
          max_entries: z.number().int().min(20).max(1200).optional().describe("Max tree entries (default 350)."),
          include_symbols: z.boolean().optional().describe("Include compact symbol sample (default false)."),
          refresh: z.boolean().optional().describe("Refresh cached profile/index.")
        }
      },
      async ({ path: rel = ".", depth = 3, max_entries = 350, include_symbols = false, refresh = false }) => {
        const rootDir = resolvePath(rel);
        const idx = await buildRepoIndex(rootDir, { depth, maxEntries: max_entries, includeSymbols: include_symbols, refresh });
        const profile = idx.profile || {};
        const tree = idx.tree || { depth, dirs: 0, files: 0, truncated: false, entries: [] };
        const importantFiles = idx.important_files || [];
        const git = idx.git || {};
        const next = recommendNextActions({ profile, git, truncated: tree.truncated });

        return jsonResult({
          kind: "workspace_snapshot",
          pro: true,
          version: VERSION,
          tier: PRODUCT_TIER,
          ts: isoNow(),
          root: toRel(rootDir),
          roots: ROOTS,
          auth: AUTH_TOKEN ? "bearer" : "none",
          execution_model: {
            trusted_local_engine: true,
            configured_roots_are_discovery_only: true,
            absolute_paths_allowed: true,
            command_os_sandbox: false,
            browser_origin_mcp_default: ALLOWED_ORIGINS.size ? "allowlist" : "blocked"
          },
          profile: {
            languages: profile.languages || [],
            frameworks: profile.frameworks || [],
            packageManagers: profile.packageManagers || [],
            manifests: profile.manifests || [],
            scripts: profile.scripts || {}
          },
          git,
          tree: {
            depth: tree.depth || depth,
            engine: tree.engine || "scan",
            dirs: tree.dirs || 0,
            files: tree.files || 0,
            truncated: Boolean(tree.truncated),
            entries: (tree.entries || []).slice(0, max_entries)
          },
          important_files: importantFiles.slice(0, 80),
          symbols: include_symbols ? (idx.symbols || []).slice(0, 80) : undefined,
          ripgrep: idx.ripgrep_status || { available: Boolean(RG_BIN), bin: RG_BIN || null },
          cache: { hit: Boolean(idx.cached), generated_at: idx.generated_at || idx.ts, ttl_seconds: Math.floor(REPO_INDEX_TTL_MS / 1000) },
          recommended_reads: recommendedReads({ importantFiles, treeEntries: tree.entries || [] }),
          workflow_hints: [
            "Use read_many for recommended_reads or multiple targeted files.",
            "Use search_text with context before reading many files.",
            "Use repo_symbols for navigation.",
            "Use review_diff for a fast local heuristic review.",
            "Run tests/build/lint only when explicitly requested."
          ],
          next_best_actions: next
        });
      }
    );

    reg(
      mcp,
      "project_profile",
      {
        title: "Project profile",
        description: "Detect languages, frameworks, package managers, and scripts in the workspace. Reads root manifests (package.json, pubspec.yaml, go.mod, Cargo.toml, etc.). Results are cached for 5 min.",
        inputSchema: {
          path: z.string().optional().describe("Root dir to inspect (default: primary root)."),
          refresh: z.boolean().optional().describe("Force re-scan even if cache is fresh.")
        }
      },
      async ({ path: rel = ".", refresh = false }) => {
        const rootDir = resolvePath(rel);
        const idx = await readRepoIndex(rootDir);
        if (!refresh && idx && indexFresh(idx) && idx.profile && idx.profile.rootDir === rootDir) {
          return jsonResult({ ...idx.profile, cached: true, ts: idx.ts });
        }
        const profile = await detectProjectProfile(rootDir);
        const entry = { rootDir, ...profile };
        const newIdx = { ...(idx || {}), ts: isoNow(), profile: entry };
        await writeRepoIndex(newIdx, rootDir);
        return jsonResult({ ...entry, cached: false, ts: newIdx.ts });
      }
    );

    reg(
      mcp,
      "important_files",
      {
        title: "Important files",
        description: "List key project files (README, config, CI, Docker, etc.) with their sizes.",
        inputSchema: {
          path: z.string().optional().describe("Root dir (default: primary root).")
        }
      },
      async ({ path: rel = "." }) => {
        const rootDir = resolvePath(rel);
        const result = await collectImportantFiles(rootDir);
        return jsonResult({ count: result.length, files: result });
      }
    );

    reg(
      mcp,
      "repo_map",
      {
        title: "Repo map",
        description: "One call: fast directory tree + detected manifests + project profile summary. Uses ripgrep file listing when available. Results cached 5 min.",
        inputSchema: {
          path: z.string().optional(),
          depth: z.number().int().min(1).max(6).optional(),
          max_entries: z.number().int().min(10).max(4000).optional(),
          refresh: z.boolean().optional()
        }
      },
      async ({ path: rel = ".", depth = 3, max_entries = 800, refresh = false }) => {
        const rootDir = resolvePath(rel);
        const idx = await buildRepoIndex(rootDir, { depth, maxEntries: max_entries, includeSymbols: false, refresh });
        const tree = idx.tree || { depth, dirs: 0, files: 0, truncated: false, entries: [] };
        const manifests = (tree.entries || []).filter((f) => MANIFEST_NAMES.has(path.basename(f).toLowerCase()));
        const profile = idx.profile || {};

        return jsonResult({
          root: toRel(rootDir),
          depth: tree.depth || depth,
          engine: tree.engine || "scan",
          dirs: tree.dirs || 0,
          files: tree.files || 0,
          truncated: Boolean(tree.truncated),
          manifests: manifests.slice(0, 100),
          tree: (tree.entries || []).slice(0, max_entries),
          profile: {
            languages: profile.languages || [],
            frameworks: profile.frameworks || [],
            packageManagers: profile.packageManagers || [],
            scripts: profile.scripts || {}
          },
          cached: Boolean(idx.cached),
          ripgrep: idx.ripgrep_status || { available: Boolean(RG_BIN), bin: RG_BIN || null }
        });
      }
    );

    reg(
      mcp,
      "repo_symbols",
      {
        title: "Repo symbols",
        description: "Scan source files for function/class/route definitions. Returns [{path, line, kind, name}]. Useful for navigation without reading entire files.",
        inputSchema: {
          path: z.string().optional().describe("Root dir to scan."),
          max_files: z.number().int().min(1).max(2000).optional(),
          max_matches: z.number().int().min(1).max(5000).optional(),
          kind: z.enum(["function", "class", "const", "method", "route"]).optional().describe("Filter by symbol kind.")
        }
      },
      async ({ path: rel = ".", max_files = 500, max_matches = 2000, kind }) => {
        const rootDir = resolvePath(rel);
        const idx = await buildRepoIndex(rootDir, {
          depth: 6,
          maxEntries: Math.max(max_files * 2, 800),
          includeSymbols: true,
          symbolMaxFiles: max_files,
          symbolMaxMatches: max_matches,
          refresh: false
        });
        let symbols = Array.isArray(idx.symbols) ? idx.symbols : [];
        if (symbols.length > max_matches || max_files < 500) {
          const seeded = relEntriesToAbs(rootDir, idx.tree?.entries || []).slice(0, max_files);
          symbols = await scanSymbols(rootDir, { files: seeded, maxFiles: max_files, maxMatches: max_matches });
        }
        const filtered = kind ? symbols.filter((s) => s.kind === kind) : symbols;
        return jsonResult({ count: filtered.length, cached: Boolean(idx.cached), symbols: filtered.slice(0, max_matches) });
      }
    );

    reg(
      mcp,
      "index_status",
      {
        title: "Index status",
        description: "Return the current repo index cache status (age, freshness, profile summary).",
        inputSchema: {}
      },
      async () => {
        const idx = await readRepoIndex(resolvePath("."));
        if (!idx) return jsonResult({ cached: false, message: "No index cached yet. Call repo_map to build it." });
        const ageMs = Date.now() - new Date(idx.ts).getTime();
        return jsonResult({
          cached: true,
          fresh: indexFresh(idx),
          ts: idx.ts,
          age_seconds: Math.floor(ageMs / 1000),
          ttl_seconds: Math.floor(REPO_INDEX_TTL_MS / 1000),
          profile_languages: idx.profile?.languages || [],
          profile_frameworks: idx.profile?.frameworks || [],
          tree_engine: idx.tree?.engine || null,
          ripgrep: idx.ripgrep_status || { available: Boolean(RG_BIN), bin: RG_BIN || null },
          symbols_cached: Array.isArray(idx.symbols)
        });
      }
    );
  }

  // ============================================================================
  // v2.2 — Patch Engine + Undo
  // ============================================================================


  return registerRepoIntelTools;
}

export function resolveContextChangedFiles(changedFiles, { hasExplicitPath, rootDir, resolvePath }) {
  return (changedFiles || []).map((file) => {
    if (path.isAbsolute(file)) return path.resolve(file);
    return path.resolve(rootDir, file);
  });
}

export function likelyReadHints(evidence, changedFiles = []) {
  const result = [];
  const seen = new Set();
  for (const file of changedFiles || []) {
    const candidate = typeof file === "string" ? file.trim() : "";
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    result.push({ path: candidate, reason: "changed_file" });
    if (result.length >= 5) return result;
  }
  for (const item of evidence || []) {
    if (!item?.path || seen.has(item.path)) continue;
    seen.add(item.path);
    result.push({
      path: item.path,
      provider: item.provider,
      ...(item.symbol ? { symbol: item.symbol } : {}),
      ...(Number(item.metadata?.line) > 0 ? { line: Number(item.metadata.line) } : {}),
      ...(Number(item.metadata?.slice_start) > 0 ? { start_line: Number(item.metadata.slice_start) } : {}),
      ...(Number(item.metadata?.slice_end) > 0 ? { end_line: Number(item.metadata.slice_end) } : {}),
      reason: item.title
    });
    if (result.length >= 5) break;
  }
  return result;
}

// Bounded source excerpts replace unnecessary follow-up read calls.
// Automatic preview never traverses symlinks outside the active project.
export async function readContextSourcePreviews(root, hints, budgetChars = 2200) {
  let remaining = Math.min(2200, Math.max(0, Math.floor(budgetChars)));
  if (remaining < 300) return [];
  const canonicalRoot = await realpath(root).catch(() => path.resolve(root));
  const previews = [];
  for (const hint of (hints || []).slice(0, 5)) {
    if (previews.length >= 2 || remaining < 300) break;
    try {
      const absolute = path.resolve(hint.path);
      // macOS /var is a symlink to /private/var; compare canonical paths only.
      const real = await realpath(absolute);
      if (!real.startsWith(canonicalRoot + path.sep)) continue;
      if (/(?:^|\/)(?:\.git|\.agent|node_modules|secrets?)(?:\/|$)/i.test(real)) continue;
      if (!/\.(?:[cm]?[jt]sx?|dart|py|java|go|rs|json)$/i.test(real)) continue;
      const info = await stat(real);
      if (!info.isFile() || info.size > 90_000) continue;
      const raw = await readFile(real, "utf8");
      if (raw.includes("\0")) continue;
      const lines = raw.split(/\r?\n/);
      const requested = Math.max(1, Number(hint.start_line || (hint.line ? hint.line - 8 : 1)) || 1);
      const start = Math.min(lines.length, requested);
      const cap = Math.min(1200, remaining);
      let content = "";
      let end = start - 1;
      for (let i = start - 1; i < Math.min(lines.length, start + 29); i += 1) {
        const next = `${i + 1}| ${lines[i]}\n`;
        if (content.length + next.length > cap) break;
        content += next;
        end = i + 1;
      }
      if (!content) continue;
      previews.push({ path: absolute, start_line: start, end_line: end, content });
      remaining -= content.length;
    } catch { /* Previews are optional and must never block workspace context. */ }
  }
  return previews;
}

export function compactVerificationHint(plan) {
  return {
    strategy: plan?.strategy || "none",
    impacted_tests: Array.isArray(plan?.impacted_tests) ? plan.impacted_tests.slice(0, 10) : [],
    gates: Array.isArray(plan?.gates) ? plan.gates.slice(0, 6).map((gate) => ({
      name: gate.name,
      command: gate.command,
      scope: gate.scope,
      reason: gate.reason
    })) : [],
    cache_hits: Number(plan?.cache?.hits || 0),
    prefetch_hit: Boolean(plan?.prefetch?.cache_hit),
    parallelizable: Array.isArray(plan?.gates) && plan.gates.length > 1,
    auto_run: false
  };
}

export function compactAutotuningHint(tuning, applied) {
  return {
    version: tuning?.version,
    mode: tuning?.mode,
    context: tuning?.context,
    prewarm_priority: tuning?.prewarm_priority,
    reasons: Array.isArray(tuning?.reasons) ? tuning.reasons.slice(0, 4) : [],
    applied
  };
}
