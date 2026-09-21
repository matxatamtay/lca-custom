import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTransactionJournal, cleanupOrphanAtomicTemps, selectBackupRetention } from "./runtime-recovery.mjs";

test("transaction journal persists prepared -> committing -> committed lifecycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-journal-life-"));
  let tick = 0;
  const journalPath = path.join(root, "journal.json");
  const journal = createTransactionJournal({ JOURNAL_PATH: journalPath, isoNow: () => `2026-09-17T00:00:0${tick++}Z` });
  try {
    const tx = await journal.begin({ tool: "apply_patch", paths: [path.join(root, "a.txt")], backup: { id: "backup-1", batchDir: path.join(root, "backup-1"), files: [] } });
    assert.equal(tx.state, "prepared");
    await journal.markCommitting(tx.id);
    await journal.markCommitted(tx.id);
    const store = await journal.read();
    assert.equal(store.transactions[0].state, "committed");
    assert.deepEqual([...await journal.protectedBackupIds()], []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup recovery restores incomplete transactions once and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-journal-recovery-"));
  const journal = createTransactionJournal({ JOURNAL_PATH: path.join(root, "journal.json"), isoNow: () => "2026-09-17T01:00:00Z" });
  let restores = 0;
  let discards = 0;
  try {
    const tx = await journal.begin({ tool: "write_file", paths: [path.join(root, "a.txt")], backup: { id: "backup-2", batchDir: path.join(root, "backup-2"), files: [{ path: path.join(root, "a.txt"), hadContent: true }] } });
    await journal.markCommitting(tx.id);
    const first = await journal.recoverIncomplete({
      restoreBackup: async (backup) => { restores += 1; assert.equal(backup.id, "backup-2"); return { ok: true, restored: [] }; },
      discardBackup: async () => { discards += 1; }
    });
    assert.equal(first.recovered, 1);
    assert.equal(first.unresolved, 0);
    assert.equal(restores, 1);
    assert.equal(discards, 1);
    const second = await journal.recoverIncomplete({ restoreBackup: async () => { restores += 1; return { ok: true }; } });
    assert.equal(second.found, 0);
    assert.equal(restores, 1);
    assert.equal((await journal.read()).transactions[0].state, "rolled_back");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup recovery reports missing backup without guessing and protects the journal record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-journal-missing-"));
  const journal = createTransactionJournal({ JOURNAL_PATH: path.join(root, "journal.json"), isoNow: () => "2026-09-17T02:00:00Z" });
  try {
    const tx = await journal.begin({ tool: "mutation", paths: [path.join(root, "a.txt")], backup: null });
    const result = await journal.recoverIncomplete({ restoreBackup: async () => { throw new Error("must not restore"); } });
    assert.equal(result.unresolved, 1);
    const record = (await journal.read()).transactions.find((item) => item.id === tx.id);
    assert.equal(record.state, "recovery_failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("orphan atomic temp cleanup removes only old LCA temp files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-temp-clean-"));
  const oldTemp = path.join(root, ".file.txt.lca-tmp-123-123e4567-e89b-42d3-a456-426614174000");
  const recentTemp = path.join(root, ".new.txt.lca-tmp-123-123e4567-e89b-42d3-a456-426614174001");
  const unrelated = path.join(root, ".file.txt.tmp-123");
  const now = Date.parse("2026-09-17T03:00:00Z");
  try {
    await writeFile(oldTemp, "old");
    await writeFile(recentTemp, "recent");
    await writeFile(unrelated, "keep");
    await utimes(oldTemp, new Date(now - 10 * 60_000), new Date(now - 10 * 60_000));
    await utimes(recentTemp, new Date(now - 10_000), new Date(now - 10_000));
    const metrics = await cleanupOrphanAtomicTemps({ roots: [root], now: () => now, minAgeMs: 60_000 });
    assert.equal(metrics.removed, 1);
    assert.equal(metrics.skipped_recent, 1);
    await assert.rejects(readFile(oldTemp), /ENOENT/);
    assert.equal(await readFile(recentTemp, "utf8"), "recent");
    assert.equal(await readFile(unrelated, "utf8"), "keep");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("backup retention never removes backup ids protected by incomplete journals", () => {
  const history = Array.from({ length: 6 }, (_, index) => ({ id: `b${index}`, batchDir: `/b${index}` }));
  const { keep, remove } = selectBackupRetention(history, new Set(["b0", "b1"]), 3);
  assert.ok(keep.some((item) => item.id === "b0"));
  assert.ok(keep.some((item) => item.id === "b1"));
  assert.equal(remove.some((item) => item.id === "b0" || item.id === "b1"), false);
  assert.ok(remove.length >= 3);
});
