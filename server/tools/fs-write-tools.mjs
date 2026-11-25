import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertExpectedHash, encodeTextLikeState, hashBytes, writeFileAtomic } from "../core/file-state.mjs";
import { applyAstRewritePlanToBuffer } from "../core/ast-grep-rewrite.mjs";
import { planTextReplacement } from "../core/text-matcher.mjs";

const HASH_SCHEMA = z.string().regex(/^[a-f0-9]{64}$/i, "expected_hash must be a SHA-256 hex digest");

export function planReplacementBatch(text, replacements) {
  let content = text;
  const results = [];
  for (const replacement of replacements || []) {
    const planned = planTextReplacement(content, replacement.old_text, replacement.new_text, {
      replaceAll: Boolean(replacement.replace_all)
    });
    content = planned.content;
    results.push({ replacements: planned.replacements, match_strategy: planned.strategy });
  }
  return {
    content,
    edits: results.length,
    replacements: results.reduce((sum, item) => sum + item.replacements, 0),
    match_strategies: results.map((item) => item.match_strategy)
  };
}

export function createFsWriteToolRegistrar(options) {
  const {
    reg, jsonResult, resolvePath, toRel, applyOperations, applyUnifiedDiff, createBackupBatch,
    runJournaledMutation, editTransaction, postEditIntelligence, workspaceStateRegistry, projectRootForPath,
    changeAwareVerification, resolveActiveProjectRoot, astGrepRewritePlanner, traceSpan
  } = options;
  const trace = (name, operation) => traceSpan ? traceSpan(name, operation) : Promise.resolve().then(operation);
  const runEdit = (paths, operation) => editTransaction?.run ? editTransaction.run(paths, operation) : operation({ paths, preState: new Map() });

  async function withPostEdit(payload, changedPaths, tool = "edit") {
    let next = payload;
    if (postEditIntelligence?.analyze) {
      try {
        next = {
          ...next,
          post_edit: await trace("workspace_edit.semantic_refresh", () => postEditIntelligence.analyze(changedPaths))
        };
      } catch (error) {
        next = { ...next, post_edit: { status: "unavailable", error: String(error?.message || error) } };
      }
    }
    try {
      const byRoot = new Map();
      for (const changedPath of changedPaths || []) {
        const root = projectRootForPath(changedPath);
        const files = byRoot.get(root) || [];
        files.push(changedPath);
        byRoot.set(root, files);
      }
      for (const [root, files] of byRoot) {
        const state = workspaceStateRegistry?.forRoot?.(root);
        const task = await state?.taskState?.recordEdit(files, { tool });
        if (task) await state?.checkpoint?.refresh({ reason: `edit:${tool}` });
      }
    } catch { /* edit success must not be downgraded by state persistence */ }
    return next;
  }

  function diffPaths(diff) {
    const paths = new Set();
    for (const line of String(diff || "").split(/\r?\n/)) {
      if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue;
      const raw = line.slice(4).replace(/^[ab]\//, "").trim();
      if (!raw || raw === "/dev/null") continue;
      try { paths.add(resolvePath(raw)); } catch { /* patch core reports the routing error */ }
    }
    return [...paths];
  }

  function operationPaths(operations) {
    const paths = [];
    for (const op of operations || []) {
      try { paths.push(resolvePath(op.path)); } catch { /* patch core reports the routing error */ }
      if (op.op === "rename" && op.rename_to) {
        try { paths.push(resolvePath(op.rename_to)); } catch { /* patch core reports the routing error */ }
      }
    }
    return [...new Set(paths)];
  }

  async function verifyChangedPaths(changedPaths, { fresh = false, timeoutMs = 120_000, tool = "apply_patch" } = {}) {
    const startedMs = performance.now();
    if (!changeAwareVerification?.execute || !changedPaths?.length) {
      return {
        requested: true,
        ok: true,
        roots: [],
        reason: "change-aware verification unavailable or no changed paths",
        duration_ms: Math.round((performance.now() - startedMs) * 10) / 10
      };
    }

    const groups = new Map();
    for (const changedPath of changedPaths) {
      const workspaceRoot = projectRootForPath(changedPath);
      let activeRoot = workspaceRoot;
      try {
        if (resolveActiveProjectRoot) {
          activeRoot = (await resolveActiveProjectRoot({
            workspaceRoot,
            requestedRoot: path.dirname(changedPath),
            changedFiles: [changedPath]
          })).root;
        }
      } catch { /* fall back to configured workspace root */ }
      const files = groups.get(activeRoot) || [];
      files.push(changedPath);
      groups.set(activeRoot, files);
    }

    const verifyRoot = async ([root, files]) => {
      try {
        const result = await changeAwareVerification.execute(root, files, {
          fresh,
          timeoutMs,
          stopOnFailure: false,
          parallel: true,
          maxConcurrency: 3
        });
        try {
          const state = workspaceStateRegistry?.forRoot?.(projectRootForPath(root));
          const task = await state?.taskState?.recordVerification(result, { tool });
          if (task) await state?.checkpoint?.refresh({ reason: `verification:${tool}` });
        } catch { /* verification result remains authoritative */ }
        return { root, files, ...result };
      } catch (error) {
        return { root, files, ok: false, error: String(error?.message || error) };
      }
    };
    const roots = await Promise.all([...groups.entries()].map(verifyRoot));
    return {
      requested: true,
      ok: roots.every((entry) => entry.ok !== false),
      roots,
      duration_ms: Math.round((performance.now() - startedMs) * 10) / 10
    };
  }

  function registerFsWriteTools(mcp) {
    reg(
      mcp,
      "write_file",
      {
        title: "Write file",
        description: "Create or overwrite a UTF-8 text file.",
        inputSchema: { path: z.string().min(1), content: z.string(), expected_hash: HASH_SCHEMA.optional() }
      },
      async ({ path: rel, content, expected_hash }) => {
        const filePath = resolvePath(rel);
        const payload = await runEdit([filePath], async ({ preState }) => {
          assertExpectedHash(preState.get(filePath), expected_hash, toRel(filePath));
          return runJournaledMutation("write_file", [filePath], async () => {
            await writeFileAtomic(filePath, Buffer.from(content, "utf8"));
            return { ok: true, path: toRel(filePath), bytes: Buffer.byteLength(content) };
          });
        });
        return jsonResult(await withPostEdit(payload, [filePath], "write_file"));
      }
    );

    reg(
      mcp,
      "replace_in_file",
      {
        title: "Replace in file",
        description: "Replace exact text in ONE file. If you are making several edits (in one or many files), call apply_patch ONCE with all of them instead of calling this repeatedly — fewer round trips, much faster.",
        inputSchema: {
          path: z.string().min(1),
          old_text: z.string().min(1).optional(),
          new_text: z.string().optional(),
          replace_all: z.boolean().optional(),
          replacements: z.array(z.object({
            old_text: z.string().min(1),
            new_text: z.string(),
            replace_all: z.boolean().optional()
          })).min(1).max(100).optional().describe("Ordered replacements applied to the same file in one read/write transaction."),
          expected_hash: HASH_SCHEMA.optional()
        }
      },
      async ({ path: rel, old_text, new_text, replace_all = false, replacements, expected_hash }) => {
        const edits = Array.isArray(replacements) && replacements.length
          ? replacements
          : old_text
            ? [{ old_text, new_text: new_text ?? "", replace_all }]
            : null;
        if (!edits) throw new Error("Provide old_text/new_text or a non-empty replacements array.");
        const filePath = resolvePath(rel);
        const payload = await runEdit([filePath], async ({ preState }) => {
          assertExpectedHash(preState.get(filePath), expected_hash, toRel(filePath));
          const state = preState.get(filePath);
          if (!state?.exists || state.kind !== "file") throw new Error(`file not found: ${toRel(filePath)}`);
          const planned = await trace("workspace_edit.match", () => planReplacementBatch(state.text, edits));
          return runJournaledMutation("replace_in_file", [filePath], async () => {
            await trace("workspace_edit.write", () =>
              writeFileAtomic(filePath, encodeTextLikeState(planned.content, state)));
            return {
              ok: true,
              path: toRel(filePath),
              edits: planned.edits,
              replacements: planned.replacements,
              match_strategies: planned.match_strategies,
              ...(planned.edits === 1 ? { match_strategy: planned.match_strategies[0] } : {})
            };
          });
        });
        return jsonResult(await withPostEdit(payload, [filePath], "replace_in_file"));
      }
    );

    reg(
      mcp,
      "apply_patch",
      {
        title: "Apply patch",
        description: "Apply MANY edits in ONE call. Two modes: (a) `diff` = a standard unified diff covering one or more files (preferred for multi-file edits), or (b) `operations` = structured create/update/delete/rename. Use this instead of many replace_in_file calls.",
        inputSchema: {
          diff: z.string().optional().describe("A unified diff (---/+++/@@). Applies by matching context, ignoring line numbers."),
          expected_hashes: z.record(HASH_SCHEMA).optional().describe("Optional SHA-256 preimage hashes keyed by patch path/read_file path."),
          verify: z.enum(["changed"]).optional().describe("Optional: after a successful patch, run the cheapest safe changed-file verification in this same call."),
          operations: z
            .array(
              z.object({
                op: z.enum(["create", "update", "delete", "rename"]),
                path: z.string().min(1),
                content: z.string().optional().describe("For create: full file content."),
                rename_to: z.string().optional().describe("For rename: destination path."),
                recursive: z.boolean().optional().describe("For delete of a directory."),
                expected_hash: HASH_SCHEMA.optional().describe("Optional SHA-256 preimage hash from read_file."),
                edits: z
                  .array(z.object({ old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().optional() }))
                  .optional()
                  .describe("For update: ordered text replacements.")
              })
            )
            .optional()
        }
      },
      async ({ diff, operations, expected_hashes, verify }) => {
        if (diff && diff.trim()) {
          const changedPaths = await trace("workspace_edit.match", () => diffPaths(diff));
          const results = await trace("workspace_edit.write", () =>
            applyUnifiedDiff(diff, { expectedHashes: expected_hashes || {} }));
          const ok = results.every((r) => r.ok);
          const payload = { ok, mode: "diff", applied: results.filter((r) => r.ok).length, results };
          if (!ok) return jsonResult(payload);
          let next = await withPostEdit(payload, changedPaths, "apply_patch_diff");
          if (verify === "changed") {
            next = {
              ...next,
              verification: await trace("workspace_edit.verify_changed", () => verifyChangedPaths(changedPaths))
            };
          }
          return jsonResult(next);
        }
        if (!operations || !operations.length) {
          throw new Error("Provide either `diff` or a non-empty `operations` array.");
        }
        const changedPaths = await trace("workspace_edit.match", () => operationPaths(operations));
        const results = await trace("workspace_edit.write", () => applyOperations(operations));
        const ok = results.every((r) => r.ok);
        const payload = { ok, mode: "operations", applied: results.filter((r) => r.ok).length, results };
        if (!ok) return jsonResult(payload);
        let next = await withPostEdit(payload, changedPaths, "apply_patch_ops");
        if (verify === "changed") {
          next = {
            ...next,
            verification: await trace("workspace_edit.verify_changed", () => verifyChangedPaths(changedPaths))
          };
        }
        return jsonResult(next);
      }
    );

    reg(
      mcp,
      "ast_rewrite",
      {
        title: "Safe structural AST rewrite",
        description: "Run an ast-grep codemod through LCA's ordinary edit transaction. Preview is the default. Applying requires explicit paths and max_matches, validates preview hashes, journals backups, runs semantic post-edit analysis, and always executes changed-file verification.",
        inputSchema: {
          pattern: z.string().min(1).max(20_000),
          rewrite: z.string().max(20_000),
          lang: z.string().min(1).max(32),
          paths: z.array(z.string().min(1)).min(1).max(32),
          max_matches: z.number().int().min(1).max(500),
          dry_run: z.boolean().optional().describe("Default true. Set false to apply the validated rewrite plan."),
          verify: z.enum(["changed"]).optional().describe("Applied rewrites always execute changed-file verification.")
        }
      },
      async ({ pattern, rewrite, lang, paths, max_matches, dry_run = true, verify = "changed" }) => {
        const resolvedScopes = [...new Set(paths.map((value) => resolvePath(value)))];
        if (!astGrepRewritePlanner?.plan) {
          return jsonResult({
            ok: false,
            engine: "ast-grep",
            available: false,
            reason: "ast_grep_unavailable",
            error: "ast-grep rewrite planner unavailable",
            dry_run,
            count: 0,
            matches: []
          });
        }

        const plan = await trace("workspace_edit.match", () => astGrepRewritePlanner.plan({
          pattern,
          rewrite,
          lang,
          paths: resolvedScopes,
          maxMatches: max_matches
        }));
        const preview = publicAstRewritePlan(plan);
        if (!plan.ok) return jsonResult({ ...preview, dry_run, applied: false });
        if (dry_run || plan.count === 0) {
          return jsonResult({ ...preview, dry_run: true, applied: false, verification: null });
        }
        if (verify !== "changed") throw new Error("ast_rewrite only supports verify=changed.");

        const changedPaths = plan.files.map((file) => file.absolute_path);
        const payload = await runEdit(changedPaths, async ({ preState }) => {
          for (const filePlan of plan.files) {
            const state = preState.get(filePlan.absolute_path);
            if (!state?.exists || state.kind !== "file") {
              throw new Error(`STALE_AST_PLAN: file missing after preview: ${filePlan.path}`);
            }
            if (state.sha256 !== filePlan.sha256) {
              throw new Error(`STALE_AST_PLAN: ${filePlan.path} changed after preview; rerun ast_rewrite.`);
            }
          }

          return runJournaledMutation("ast_rewrite", changedPaths, async () => {
            const results = [];
            for (const filePlan of plan.files) {
              const raw = await readFile(filePlan.absolute_path);
              if (hashBytes(raw) !== filePlan.sha256) {
                throw new Error(`STALE_AST_PLAN: ${filePlan.path} changed while acquiring the rewrite transaction.`);
              }
              const nextBuffer = applyAstRewritePlanToBuffer(raw, filePlan.matches, filePlan.path);
              await trace("workspace_edit.write", () =>
                writeFileAtomic(filePlan.absolute_path, nextBuffer));
              results.push({
                path: filePlan.path,
                replacements: filePlan.matches.length,
                bytes_before: raw.length,
                bytes_after: nextBuffer.length
              });
            }
            return {
              ok: true,
              mode: "ast_rewrite",
              applied: true,
              applied_files: results.length,
              replacements: plan.count,
              results,
              rollback: "workspace_edit action=undo restores the most recent ast_rewrite backup"
            };
          });
        });

        let next = await withPostEdit({ ...payload, preview }, changedPaths, "ast_rewrite");
        const verification = await trace(
          "workspace_edit.verify_changed",
          () => verifyChangedPaths(changedPaths, { tool: "ast_rewrite" })
        );
        next = {
          ...next,
          ok: verification.ok,
          regression_gate: verification.ok ? "pass" : "fail",
          rollback_available: true,
          verification
        };
        return jsonResult(next);
      }
    );

    reg(
      mcp,
      "make_dir",
      {
        title: "Make directory",
        description: "Create a directory (recursive).",
        inputSchema: { path: z.string().min(1) }
      },
      async ({ path: rel }) => {
        const dir = resolvePath(rel);
        return runEdit([dir], async () => {
          await mkdir(dir, { recursive: true });
          return jsonResult({ ok: true, path: toRel(dir) });
        });
      }
    );

    reg(
      mcp,
      "move_path",
      {
        title: "Move / rename",
        description: "Move or rename a file or directory. Both ends must be inside the roots.",
        inputSchema: { from: z.string().min(1), to: z.string().min(1), expected_hash: HASH_SCHEMA.optional() }
      },
      async ({ from, to, expected_hash }) => {
        const src = resolvePath(from);
        const dst = resolvePath(to);
        return runEdit([src, dst], async ({ preState }) => {
          assertExpectedHash(preState.get(src), expected_hash, toRel(src));
          const payload = await runJournaledMutation("move_path", [src, dst], async () => {
            await mkdir(path.dirname(dst), { recursive: true });
            await rename(src, dst);
            return { ok: true, from: toRel(src), to: toRel(dst) };
          });
          return jsonResult(payload);
        });
      }
    );

    reg(
      mcp,
      "delete_path",
      {
        title: "Delete path",
        description: "Delete a file or directory inside the roots. Directories require recursive=true.",
        inputSchema: { path: z.string().min(1), recursive: z.boolean().optional(), expected_hash: HASH_SCHEMA.optional() }
      },
      async ({ path: rel, recursive = false, expected_hash }) => {
        const target = resolvePath(rel);
        return runEdit([target], async ({ preState }) => {
          assertExpectedHash(preState.get(target), expected_hash, toRel(target));
          const info = await stat(target);
          if (info.isDirectory() && !recursive) throw new Error("Path is a directory; pass recursive=true to delete it.");
          if (info.isFile()) {
            const payload = await runJournaledMutation("delete_path", [target], async () => {
              await rm(target, { recursive: false, force: false });
              return { ok: true, deleted: toRel(target) };
            });
            return jsonResult(payload);
          }
          await rm(target, { recursive, force: false });
          return jsonResult({ ok: true, deleted: toRel(target), recovery: "directory delete is not journaled to avoid copying arbitrarily large trees" });
        });
      }
    );
  }

  // Apply a unified diff by CONTENT matching (ignores the @@ line numbers, which
  // models often get wrong). Each hunk's context+removed lines must appear in the
  // file; they are replaced by its context+added lines.

  return registerFsWriteTools;
}

function publicAstRewritePlan(plan = {}) {
  return {
    engine: "ast-grep",
    available: plan.available !== false,
    ok: plan.ok === true,
    reason: plan.reason || null,
    ...(plan.error ? { error: plan.error } : {}),
    pattern: plan.pattern,
    rewrite: plan.rewrite,
    lang: plan.lang,
    max_matches: plan.max_matches,
    count: Number(plan.count || 0),
    overflow: plan.overflow === true,
    scopes: plan.scopes || [],
    files: (plan.files || []).map((file) => ({
      path: file.path,
      sha256: file.sha256,
      bytes_before: file.bytes_before,
      replacements: file.matches?.length || 0
    })),
    matches: plan.matches || []
  };
}
