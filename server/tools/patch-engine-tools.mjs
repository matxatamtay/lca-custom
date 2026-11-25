import { existsSync } from "node:fs";
import { z } from "zod";
import { assertExpectedHash, readPathState } from "../core/file-state.mjs";
import { planTextReplacement } from "../core/text-matcher.mjs";

const HASH_SCHEMA = z.string().regex(/^[a-f0-9]{64}$/i, "expected_hash must be a SHA-256 hex digest");

export function createPatchEngineToolRegistrar(options) {
  const { reg, jsonResult, dryRunUnifiedDiff, readPatchHistory, resolvePath, restoreBackupBatch, writePatchHistory } = options;

  function registerPatchEngineTools(mcp) {
    reg(
      mcp,
      "preview_patch",
      {
        title: "Preview patch (dry run)",
        description: "DRY RUN — compute what a patch/operations would change WITHOUT writing. Returns per-file match status and before/after summary.",
        inputSchema: {
          diff: z.string().optional().describe("Unified diff to preview."),
          expected_hashes: z.record(HASH_SCHEMA).optional(),
          operations: z.array(z.object({
            op: z.enum(["create", "update", "delete", "rename"]),
            path: z.string().min(1),
            content: z.string().optional(),
            rename_to: z.string().optional(),
            recursive: z.boolean().optional(),
            expected_hash: HASH_SCHEMA.optional(),
            edits: z.array(z.object({ old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().optional() })).optional()
          })).optional()
        }
      },
      async ({ diff, operations, expected_hashes }) => {
        if (diff && diff.trim()) {
          const results = await dryRunUnifiedDiff(diff, { expectedHashes: expected_hashes || {} });
          const allOk = results.every((r) => r.ok);
          return jsonResult({ ok: allOk, mode: "diff", files: results });
        }
        if (!operations || !operations.length) throw new Error("Provide diff or operations.");
        const results = [];
        for (const op of operations) {
          try {
            const target = resolvePath(op.path);
            const state = await readPathState(target);
            assertExpectedHash(state, op.expected_hash, op.path);
            if (op.op === "create") {
              results.push({ op: "create", path: op.path, ok: true, bytes: Buffer.byteLength(op.content ?? "") });
            } else if (op.op === "update") {
              let content = state.text;
              const checks = [];
              for (const edit of op.edits || []) {
                try {
                  const planned = planTextReplacement(content, edit.old_text, edit.new_text, { replaceAll: Boolean(edit.replace_all) });
                  content = planned.content;
                  checks.push({ old_text_chars: edit.old_text.length, match: true, strategy: planned.strategy, occurrences: planned.occurrences, new_text_chars: edit.new_text.length });
                } catch (error) {
                  checks.push({ old_text_chars: edit.old_text.length, match: false, new_text_chars: edit.new_text.length, conflict: String(error?.message || error) });
                }
              }
              const allMatch = checks.every((c) => c.match);
              results.push({ op: "update", path: op.path, ok: allMatch, edits: checks, conflict: allMatch ? null : checks.find((c) => !c.match)?.conflict || "edit conflict" });
            } else if (op.op === "delete") {
              const exists = existsSync(target);
              results.push({ op: "delete", path: op.path, ok: exists, conflict: exists ? null : "file not found" });
            } else if (op.op === "rename") {
              const exists = existsSync(target);
              results.push({ op: "rename", path: op.path, rename_to: op.rename_to, ok: exists, conflict: exists ? null : "source not found" });
            }
          } catch (err) {
            results.push({ op: op.op, path: op.path, ok: false, conflict: String(err?.message || err) });
          }
        }
        return jsonResult({ ok: results.every((r) => r.ok), mode: "operations", files: results });
      }
    );

    reg(
      mcp,
      "validate_patch",
      {
        title: "Validate patch",
        description: "Like preview_patch but only returns ok status and a list of conflicts (ambiguous/not-found hunks). Fast check before apply.",
        inputSchema: {
          diff: z.string().optional(),
          expected_hashes: z.record(HASH_SCHEMA).optional(),
          operations: z.array(z.object({
            op: z.enum(["create", "update", "delete", "rename"]),
            path: z.string().min(1),
            content: z.string().optional(),
            rename_to: z.string().optional(),
            expected_hash: HASH_SCHEMA.optional(),
            edits: z.array(z.object({ old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().optional() })).optional()
          })).optional()
        }
      },
      async ({ diff, operations, expected_hashes }) => {
        if (diff && diff.trim()) {
          const results = await dryRunUnifiedDiff(diff, { expectedHashes: expected_hashes || {} });
          const conflicts = results.filter((r) => !r.ok).map((r) => ({ path: r.path, conflict: r.conflict }));
          return jsonResult({ ok: conflicts.length === 0, conflicts });
        }
        if (!operations || !operations.length) throw new Error("Provide diff or operations.");
        const conflicts = [];
        for (const op of operations) {
          try {
            const target = resolvePath(op.path);
            const state = await readPathState(target);
            assertExpectedHash(state, op.expected_hash, op.path);
            if (op.op === "update") {
              let content = state.text;
              for (const e of op.edits || []) {
                try {
                  const planned = planTextReplacement(content, e.old_text, e.new_text, { replaceAll: Boolean(e.replace_all) });
                  content = planned.content;
                } catch (error) {
                  conflicts.push({ path: op.path, conflict: String(error?.message || error) });
                }
              }
            } else if (op.op === "delete" || op.op === "rename") {
              if (!existsSync(target)) conflicts.push({ path: op.path, conflict: "file not found" });
            }
          } catch (err) {
            conflicts.push({ path: op.path, conflict: String(err?.message || err) });
          }
        }
        return jsonResult({ ok: conflicts.length === 0, conflicts });
      }
    );

    reg(
      mcp,
      "undo_last_patch",
      {
        title: "Undo last patch",
        description: "Restore files from the most recent backup batch. Reverts modified files, recreates deleted files, removes created files.",
        inputSchema: {}
      },
      async () => {
        const history = await readPatchHistory();
        if (!history.length) throw new Error("No patch history to undo.");
        const batch = history[history.length - 1];
        const restored = await restoreBackupBatch(batch, { consumeHistory: true });
        return jsonResult({ ...restored, tool: batch.tool, ts: batch.ts });
      }
    );
  }


  return registerPatchEngineTools;
}
