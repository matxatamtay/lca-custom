import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertExpectedHash,
  encodeTextLikeState,
  readPathState,
  writeFileAtomic
} from "./file-state.mjs";
import { planTextReplacement } from "./text-matcher.mjs";
import { selectBackupRetention } from "./runtime-recovery.mjs";

export function createPatchCore(options) {
  const { BACKUPS_DIR, PATCH_HISTORY_PATH, editTransaction, isoNow, resolvePath, toRel, transactionJournal } = options;
  const runEdit = (paths, operation) => editTransaction?.run
    ? editTransaction.run(paths, operation)
    : operation({ paths, preState: new Map() });

  function parseUnifiedDiff(diffText) {
    const lines = String(diffText || "").split(/\r?\n/);
    const fileChunks = [];
    let current = null;
    const stripPrefix = (value) => value.replace(/^["']|["']$/g, "").replace(/^[ab]\//, "").trim();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("--- ")) {
        const next = lines[i + 1] || "";
        const minus = stripPrefix(line.slice(4));
        const plus = next.startsWith("+++ ") ? stripPrefix(next.slice(4)) : "";
        current = { minus, plus, hunks: [], hunk: null };
        fileChunks.push(current);
        if (next.startsWith("+++ ")) i++;
        continue;
      }
      if (!current) continue;
      if (line.startsWith("@@")) {
        current.hunk = { before: [], after: [] };
        current.hunks.push(current.hunk);
        continue;
      }
      if (!current.hunk) continue;
      const tag = line[0];
      const body = line.slice(1);
      if (tag === " ") {
        current.hunk.before.push(body);
        current.hunk.after.push(body);
      } else if (tag === "-") {
        current.hunk.before.push(body);
      } else if (tag === "+") {
        current.hunk.after.push(body);
      }
    }

    if (!fileChunks.length) throw new Error("No file sections found in diff (need ---/+++ headers).");
    return fileChunks;
  }

  function diffEntry(fileChunk) {
    const isNew = fileChunk.minus === "/dev/null";
    const isDelete = fileChunk.plus === "/dev/null";
    const relPath = isNew ? fileChunk.plus : fileChunk.minus || fileChunk.plus;
    return { fileChunk, isNew, isDelete, relPath, target: resolvePath(relPath) };
  }

  function expectedHashFor(expectedHashes, entry) {
    return expectedHashes?.[entry.relPath]
      || expectedHashes?.[toRel(entry.target)]
      || expectedHashes?.[entry.target];
  }

  function transactionFailure(entries, error, prefix = "TRANSACTION_ABORTED") {
    const message = `${prefix}: ${String(error?.message || error)}`;
    return entries.map((entry) => ({
      path: toRel(entry.target),
      ok: false,
      action: entry.isDelete ? "delete" : entry.isNew ? "create" : "update",
      error: message
    }));
  }

  function prepareDiffEntry(entry, state, expectedHashes) {
    assertExpectedHash(state, expectedHashFor(expectedHashes, entry), toRel(entry.target));
    if (entry.isDelete) {
      return {
        ...entry,
        kind: "delete",
        result: { path: toRel(entry.target), ok: true, action: "delete" }
      };
    }
    if (entry.isNew) {
      const content = entry.fileChunk.hunks.flatMap((hunk) => hunk.after).join("\n");
      const finalContent = content.endsWith("\n") ? content : `${content}\n`;
      return {
        ...entry,
        kind: "write",
        bytes: Buffer.from(finalContent, "utf8"),
        result: { path: toRel(entry.target), ok: true, action: "create" }
      };
    }
    if (!state?.exists || state.kind !== "file") throw new Error(`file not found: ${toRel(entry.target)}`);

    let content = state.text;
    let applied = 0;
    const strategies = [];
    for (const hunk of entry.fileChunk.hunks) {
      const before = hunk.before.join("\n");
      const after = hunk.after.join("\n");
      if (before === after) continue;
      if (before) {
        const planned = planTextReplacement(content, before, after);
        content = planned.content;
        applied += planned.replacements;
        strategies.push(planned.strategy);
      } else {
        content += (content.endsWith("\n") ? "" : "\n") + after;
        applied++;
        strategies.push("append");
      }
    }
    return {
      ...entry,
      kind: "write",
      bytes: encodeTextLikeState(content, state),
      result: {
        path: toRel(entry.target),
        ok: true,
        action: "update",
        hunks: applied,
        match_strategies: strategies
      }
    };
  }

  async function commitPrepared(prepared) {
    for (const item of prepared) {
      if (item.kind === "write") {
        await writeFileAtomic(item.target, item.bytes);
      } else if (item.kind === "delete") {
        await rm(item.target, { recursive: Boolean(item.recursive), force: Boolean(item.force) });
      } else if (item.kind === "rename") {
        await mkdir(path.dirname(item.dst), { recursive: true });
        await rename(item.target, item.dst);
      } else {
        throw new Error(`Unknown prepared mutation: ${item.kind}`);
      }
    }
  }

  async function applyUnifiedDiff(diffText, { expectedHashes = {} } = {}) {
    let entries;
    try {
      entries = parseUnifiedDiff(diffText).map(diffEntry);
    } catch (error) {
      if (/No file sections/.test(String(error?.message || error))) throw error;
      return [{ path: "<unresolved>", ok: false, action: "unknown", error: String(error?.message || error) }];
    }

    const paths = entries.map((entry) => entry.target);
    return runEdit(paths, async ({ preState }) => {
      let prepared;
      try {
        prepared = entries.map((entry) => prepareDiffEntry(entry, preState.get(entry.target), expectedHashes));
      } catch (error) {
        return transactionFailure(entries, error);
      }

      try {
        await runJournaledMutation("apply_patch_diff", paths, async () => {
          await commitPrepared(prepared);
        });
        return prepared.map((item) => item.result);
      } catch (error) {
        return transactionFailure(entries, error, "TRANSACTION_ROLLED_BACK");
      }
    });
  }

  function resolveOperation(op) {
    if (!op?.op || !op?.path) throw new Error("Invalid patch operation");
    const target = resolvePath(op.path);
    if (op.op === "rename") {
      if (!op.rename_to) throw new Error("rename requires rename_to");
      return { op, target, dst: resolvePath(op.rename_to) };
    }
    return { op, target, dst: null };
  }

  function prepareOperation(entry, preState) {
    const { op, target, dst } = entry;
    const state = preState.get(target);
    assertExpectedHash(state, op.expected_hash, toRel(target));

    if (op.op === "create") {
      return {
        ...entry,
        kind: "write",
        bytes: Buffer.from(op.content ?? "", "utf8"),
        result: { op: "create", path: toRel(target), ok: true, bytes: Buffer.byteLength(op.content ?? "") }
      };
    }

    if (op.op === "update") {
      if (!state?.exists || state.kind !== "file") throw new Error(`file not found: ${toRel(target)}`);
      let content = state.text;
      let replacements = 0;
      const strategies = [];
      for (const edit of op.edits || []) {
        const planned = planTextReplacement(content, edit.old_text, edit.new_text, { replaceAll: Boolean(edit.replace_all) });
        content = planned.content;
        replacements += planned.replacements;
        strategies.push(planned.strategy);
      }
      return {
        ...entry,
        kind: "write",
        bytes: encodeTextLikeState(content, state),
        result: { op: "update", path: toRel(target), ok: true, replacements, match_strategies: strategies }
      };
    }

    if (op.op === "delete") {
      if (!state?.exists) throw new Error(`file not found: ${toRel(target)}`);
      return {
        ...entry,
        kind: "delete",
        recursive: Boolean(op.recursive),
        force: false,
        result: { op: "delete", path: toRel(target), ok: true }
      };
    }

    if (op.op === "rename") {
      if (!state?.exists) throw new Error(`file not found: ${toRel(target)}`);
      return {
        ...entry,
        kind: "rename",
        result: { op: "rename", path: toRel(target), to: toRel(dst), ok: true }
      };
    }

    throw new Error(`Unknown op: ${op.op}`);
  }

  function operationFailure(entries, error, prefix = "TRANSACTION_ABORTED") {
    const message = `${prefix}: ${String(error?.message || error)}`;
    return entries.map((entry) => ({ op: entry.op.op, path: entry.op.path, ok: false, error: message }));
  }

  async function applyOperations(operations) {
    let entries;
    try {
      entries = operations.map(resolveOperation);
    } catch (error) {
      return [{ op: "unknown", path: "<unresolved>", ok: false, error: String(error?.message || error) }];
    }
    const paths = entries.flatMap((entry) => entry.dst ? [entry.target, entry.dst] : [entry.target]);
    return runEdit(paths, async ({ preState }) => {
      let prepared;
      try {
        prepared = entries.map((entry) => prepareOperation(entry, preState));
      } catch (error) {
        return operationFailure(entries, error);
      }

      try {
        await runJournaledMutation("apply_patch_ops", paths, async () => {
          await commitPrepared(prepared);
        });
        return prepared.map((item) => item.result);
      } catch (error) {
        return operationFailure(entries, error, "TRANSACTION_ROLLED_BACK");
      }
    });
  }

  async function applyOne(op) {
    const results = await applyOperations([op]);
    const result = results[0];
    if (!result?.ok) throw new Error(result?.error || "Patch operation failed");
    return result;
  }

  async function readPatchHistory() {
    try {
      return JSON.parse(await readFile(PATCH_HISTORY_PATH, "utf8"));
    } catch {
      return [];
    }
  }

  async function writePatchHistory(history) {
    await mkdir(path.dirname(PATCH_HISTORY_PATH), { recursive: true });
    await writeFile(PATCH_HISTORY_PATH, JSON.stringify(history, null, 2), "utf8");
  }

  async function createBackupBatch(tool, filePaths) {
    const batchId = randomUUID();
    const batchDir = path.join(BACKUPS_DIR, batchId);
    await mkdir(batchDir, { recursive: true });

    const files = [];
    const uniquePaths = [...new Set(filePaths.map((filePath) => path.normalize(resolvePath(filePath))))];
    for (const abs of uniquePaths) {
      let hadContent = false;
      try {
        if (existsSync(abs)) {
          const info = await stat(abs);
          const backupFile = path.join(batchDir, `${files.length}-${path.basename(abs) || "root"}`);
          if (info.isDirectory()) await cp(abs, backupFile, { recursive: true, force: true });
          else await copyFile(abs, backupFile);
          hadContent = true;
          files.push({ path: abs, backupFile, hadContent, kind: info.isDirectory() ? "directory" : "file" });
        } else {
          files.push({ path: abs, backupFile: null, hadContent: false, kind: "missing" });
        }
      } catch (error) {
        await rm(batchDir, { recursive: true, force: true }).catch(() => {});
        throw new Error(`BACKUP_FAILED: ${toRel(abs)}: ${String(error?.message || error)}`);
      }
    }

    const record = { id: batchId, ts: isoNow(), tool, batchDir, files };
    const history = await readPatchHistory();
    history.push(record);
    await writePatchHistory(history);
    await pruneBackupHistory(50);
    return record;
  }

  async function discardBackupBatch(batch) {
    if (!batch?.id) return { ok: true, discarded: false };
    const history = await readPatchHistory();
    const next = history.filter((record) => record.id !== batch.id);
    if (next.length !== history.length) await writePatchHistory(next);
    if (batch.batchDir) await rm(batch.batchDir, { recursive: true, force: true }).catch(() => {});
    return { ok: true, discarded: true, id: batch.id };
  }

  async function pruneBackupHistory(limit = 50) {
    const history = await readPatchHistory();
    const protectedIds = transactionJournal?.protectedBackupIds
      ? await transactionJournal.protectedBackupIds().catch(() => new Set())
      : new Set();
    const retention = selectBackupRetention(history, protectedIds, limit);
    if (retention.remove.length > 0) {
      await writePatchHistory(retention.keep);
      await Promise.all(retention.remove.map((record) => record?.batchDir
        ? rm(record.batchDir, { recursive: true, force: true }).catch(() => {})
        : Promise.resolve()));
    }
    return {
      before: history.length,
      kept: retention.keep.length,
      removed: retention.remove.length,
      protected: protectedIds.size
    };
  }

  async function runJournaledMutation(tool, filePaths, operation) {
    const backup = await createBackupBatch(tool, filePaths);
    let journalRecord = null;
    try {
      if (transactionJournal?.begin) {
        journalRecord = await transactionJournal.begin({ tool, paths: filePaths, backup });
        await transactionJournal.markCommitting(journalRecord.id);
      }
      const result = await operation(backup);
      if (journalRecord) await transactionJournal.markCommitted(journalRecord.id);
      return result;
    } catch (error) {
      const restored = await restoreBackupBatch(backup, { consumeHistory: false }).catch((restoreError) => ({
        ok: false,
        restored: [],
        errors: [{ path: "<transaction>", error: String(restoreError?.message || restoreError) }]
      }));
      let journalResolved = !journalRecord;
      if (journalRecord) {
        if (restored?.ok) {
          try {
            await transactionJournal.markRolledBack(journalRecord.id, {
              rollback_error: String(error?.message || error).slice(0, 2000)
            });
            journalResolved = true;
          } catch {
            journalResolved = false;
          }
        } else {
          await transactionJournal.markRecoveryFailed(journalRecord.id, new Error(
            `Mutation failed (${String(error?.message || error)}); rollback also failed (${JSON.stringify(restored?.errors || [])})`
          )).catch(() => {});
        }
      }
      if (restored?.ok && journalResolved) await discardBackupBatch(backup).catch(() => {});
      const rollbackSuffix = restored?.ok ? "" : `; rollback errors: ${JSON.stringify(restored?.errors || [])}`;
      throw new Error(`${String(error?.message || error)}${rollbackSuffix}`);
    }
  }

  async function restoreBackupBatch(batch, { consumeHistory = false } = {}) {
    const restored = [];
    const errors = [];
    for (const file of batch.files || []) {
      try {
        const abs = resolvePath(file.path);
        if (file.hadContent && file.backupFile && existsSync(file.backupFile)) {
          await rm(abs, { recursive: true, force: true });
          await mkdir(path.dirname(abs), { recursive: true });
          if (file.kind === "directory") await cp(file.backupFile, abs, { recursive: true, force: true });
          else await copyFile(file.backupFile, abs);
          restored.push({ path: file.path, action: "restored" });
        } else if (!file.hadContent && existsSync(abs)) {
          await rm(abs, { recursive: true, force: true });
          restored.push({ path: file.path, action: "removed (was created)" });
        } else {
          restored.push({ path: file.path, action: "skipped (no backup)" });
        }
      } catch (error) {
        errors.push({ path: file.path, error: String(error?.message || error) });
      }
    }

    if (consumeHistory) await discardBackupBatch(batch);
    return { ok: errors.length === 0, restored, errors };
  }

  async function dryRunUnifiedDiff(diffText, { expectedHashes = {} } = {}) {
    const results = [];
    let entries;
    try {
      entries = parseUnifiedDiff(diffText).map(diffEntry);
    } catch (error) {
      if (/No file sections/.test(String(error?.message || error))) throw error;
      return [{ path: "<unresolved>", action: "unknown", ok: false, conflict: String(error?.message || error) }];
    }

    for (const entry of entries) {
      try {
        const state = await readPathState(entry.target);
        assertExpectedHash(state, expectedHashFor(expectedHashes, entry), toRel(entry.target));
        if (entry.isDelete) {
          results.push({ path: entry.relPath, action: "delete", exists: state.exists, ok: state.exists, conflict: state.exists ? null : "file not found" });
          continue;
        }
        if (entry.isNew) {
          const content = entry.fileChunk.hunks.flatMap((hunk) => hunk.after).join("\n");
          results.push({ path: entry.relPath, action: "create", exists: state.exists, ok: true, preview_chars: content.length });
          continue;
        }
        if (!state.exists || state.kind !== "file") throw new Error("file not found");
        const hunkResults = [];
        let previewContent = state.text;
        let allMatch = true;
        for (const hunk of entry.fileChunk.hunks) {
          const before = hunk.before.join("\n");
          const after = hunk.after.join("\n");
          if (before === after) {
            hunkResults.push({ match: true, skipped: true });
            continue;
          }
          if (before) {
            try {
              const planned = planTextReplacement(previewContent, before, after);
              previewContent = planned.content;
              hunkResults.push({ match: true, strategy: planned.strategy, occurrences: planned.occurrences, before_chars: before.length, after_chars: after.length });
            } catch (error) {
              allMatch = false;
              hunkResults.push({ match: false, before_chars: before.length, after_chars: after.length, conflict: String(error?.message || error) });
            }
          } else {
            hunkResults.push({ match: true, strategy: "append", before_chars: 0, after_chars: after.length });
            previewContent += (previewContent.endsWith("\n") ? "" : "\n") + after;
          }
        }
        results.push({ path: entry.relPath, action: "update", ok: allMatch, hunks: hunkResults, conflict: allMatch ? null : "one or more hunks did not match" });
      } catch (error) {
        results.push({ path: entry.relPath, action: "unknown", ok: false, conflict: String(error?.message || error) });
      }
    }
    return results;
  }

  return {
    applyOne,
    applyOperations,
    applyUnifiedDiff,
    createBackupBatch,
    discardBackupBatch,
    dryRunUnifiedDiff,
    readPatchHistory,
    restoreBackupBatch,
    runJournaledMutation,
    pruneBackupHistory,
    writePatchHistory
  };
}
