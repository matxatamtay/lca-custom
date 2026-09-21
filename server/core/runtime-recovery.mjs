import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./file-state.mjs";

const ACTIVE_TRANSACTION_STATES = new Set(["prepared", "committing", "recovery_failed"]);
const RECOVERABLE_TRANSACTION_STATES = new Set(["prepared", "committing", "recovery_failed"]);
const DEFAULT_JOURNAL_RECORDS = 200;
const TEMP_PATTERN = /^\..+\.lca-tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createTransactionJournal(options) {
  const {
    JOURNAL_PATH,
    isoNow = () => new Date().toISOString(),
    maxRecords = DEFAULT_JOURNAL_RECORDS
  } = options;
  let queue = Promise.resolve();

  function serialized(operation) {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  }

  async function read() {
    try {
      const parsed = JSON.parse(await readFile(JOURNAL_PATH, "utf8"));
      return {
        version: 1,
        transactions: Array.isArray(parsed?.transactions) ? parsed.transactions : []
      };
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, transactions: [] };
      throw new Error(`Transaction journal is unreadable: ${error?.message || error}`);
    }
  }

  async function write(store) {
    await mkdir(path.dirname(JOURNAL_PATH), { recursive: true });
    await writeFileAtomic(JOURNAL_PATH, Buffer.from(`${JSON.stringify(store, null, 2)}\n`, "utf8"));
  }

  function compactStore(store) {
    const active = store.transactions.filter((record) => ACTIVE_TRANSACTION_STATES.has(record.state));
    const terminal = store.transactions.filter((record) => !ACTIVE_TRANSACTION_STATES.has(record.state));
    const terminalLimit = Math.max(0, maxRecords - active.length);
    return {
      version: 1,
      transactions: [...active, ...terminal.slice(-terminalLimit)]
        .sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")))
    };
  }

  async function begin({ tool, paths, backup }) {
    return serialized(async () => {
      const store = await read();
      const now = isoNow();
      const record = {
        id: randomUUID(),
        tool: String(tool || "mutation"),
        state: "prepared",
        paths: [...new Set((paths || []).map((value) => path.resolve(value)))],
        backup: backup ? cloneBackup(backup) : null,
        backup_id: backup?.id || null,
        created_at: now,
        updated_at: now
      };
      store.transactions.push(record);
      await write(compactStore(store));
      return record;
    });
  }

  async function transition(id, state, details = {}) {
    return serialized(async () => {
      const store = await read();
      const record = store.transactions.find((item) => item.id === id);
      if (!record) throw new Error(`Transaction journal record not found: ${id}`);
      record.state = state;
      record.updated_at = isoNow();
      Object.assign(record, sanitizeDetails(details));
      await write(compactStore(store));
      return record;
    });
  }

  async function markCommitting(id) {
    return transition(id, "committing");
  }

  async function markCommitted(id) {
    return transition(id, "committed", { committed_at: isoNow() });
  }

  async function markRolledBack(id, details = {}) {
    return transition(id, "rolled_back", { rolled_back_at: isoNow(), ...details });
  }

  async function markRecoveryFailed(id, error) {
    return transition(id, "recovery_failed", {
      recovery_failed_at: isoNow(),
      recovery_error: String(error?.message || error).slice(0, 2000)
    });
  }

  async function protectedBackupIds() {
    const store = await read();
    return new Set(store.transactions
      .filter((record) => ACTIVE_TRANSACTION_STATES.has(record.state) && record.backup_id)
      .map((record) => String(record.backup_id)));
  }

  async function recoverIncomplete({ restoreBackup, discardBackup } = {}) {
    const store = await read();
    const candidates = store.transactions.filter((record) => RECOVERABLE_TRANSACTION_STATES.has(record.state));
    const metrics = {
      found: candidates.length,
      recovered: 0,
      unresolved: 0,
      records: []
    };

    for (const record of candidates) {
      if (!record.backup || !record.backup_id) {
        await markRecoveryFailed(record.id, new Error("Incomplete transaction has no backup reference; no recovery mutation was attempted."));
        metrics.unresolved += 1;
        metrics.records.push({ id: record.id, tool: record.tool, status: "unresolved", reason: "missing_backup" });
        continue;
      }
      try {
        const restored = await restoreBackup(record.backup);
        if (!restored?.ok) throw new Error(`Backup restore reported errors: ${JSON.stringify(restored?.errors || [])}`);
        await markRolledBack(record.id, { recovered_on_startup: true });
        if (discardBackup) await discardBackup(record.backup).catch(() => {});
        metrics.recovered += 1;
        metrics.records.push({ id: record.id, tool: record.tool, status: "recovered", backup_id: record.backup_id });
      } catch (error) {
        await markRecoveryFailed(record.id, error).catch(() => {});
        metrics.unresolved += 1;
        metrics.records.push({ id: record.id, tool: record.tool, status: "unresolved", reason: String(error?.message || error).slice(0, 500) });
      }
    }
    return metrics;
  }

  return {
    read,
    begin,
    transition,
    markCommitting,
    markCommitted,
    markRolledBack,
    markRecoveryFailed,
    protectedBackupIds,
    recoverIncomplete
  };
}

export async function cleanupOrphanAtomicTemps(options) {
  const {
    roots,
    now = () => Date.now(),
    minAgeMs = 5 * 60_000,
    maxDirs = 5_000,
    maxEntries = 50_000,
    skipDirs = new Set([".git", "node_modules", "dist", "build", ".dart_tool", ".gradle", ".next", ".cache"])
  } = options;
  const metrics = {
    scanned_dirs: 0,
    scanned_entries: 0,
    candidates: 0,
    removed: 0,
    skipped_recent: 0,
    errors: 0,
    truncated: false
  };
  const seen = new Set();

  async function walk(dir) {
    if (metrics.scanned_dirs >= maxDirs || metrics.scanned_entries >= maxEntries) {
      metrics.truncated = true;
      return;
    }
    const normalized = path.resolve(dir);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    let entries;
    try { entries = await readdir(normalized, { withFileTypes: true }); }
    catch { metrics.errors += 1; return; }
    metrics.scanned_dirs += 1;

    for (const entry of entries) {
      if (metrics.scanned_entries >= maxEntries) { metrics.truncated = true; return; }
      metrics.scanned_entries += 1;
      const absolute = path.join(normalized, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) await walk(absolute);
        continue;
      }
      if (!TEMP_PATTERN.test(entry.name)) continue;
      metrics.candidates += 1;
      try {
        const info = await lstat(absolute);
        const age = Math.max(0, now() - info.mtimeMs);
        if (age < minAgeMs) { metrics.skipped_recent += 1; continue; }
        await rm(absolute, { force: true });
        metrics.removed += 1;
      } catch {
        metrics.errors += 1;
      }
    }
  }

  for (const root of [...new Set((roots || []).filter(Boolean).map((value) => path.resolve(value)))]) {
    if (existsSync(root)) await walk(root);
    if (metrics.truncated) break;
  }
  return metrics;
}

export function selectBackupRetention(history, protectedIds, limit = 50) {
  const records = Array.isArray(history) ? history : [];
  const protectedSet = protectedIds instanceof Set ? protectedIds : new Set(protectedIds || []);
  if (records.length <= limit) return { keep: [...records], remove: [] };

  const remove = [];
  const keep = [...records];
  for (let index = 0; index < keep.length && keep.length - remove.length > limit; index += 1) {
    const record = keep[index];
    if (!record || protectedSet.has(String(record.id))) continue;
    remove.push(record);
  }
  const removeIds = new Set(remove.map((record) => record.id));
  return { keep: keep.filter((record) => !removeIds.has(record.id)), remove };
}

function cloneBackup(backup) {
  return JSON.parse(JSON.stringify({
    id: backup.id,
    ts: backup.ts,
    tool: backup.tool,
    batchDir: backup.batchDir,
    files: backup.files
  }));
}

function sanitizeDetails(details) {
  const result = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (value === undefined) continue;
    result[key] = typeof value === "string" ? value.slice(0, 4000) : value;
  }
  return result;
}
