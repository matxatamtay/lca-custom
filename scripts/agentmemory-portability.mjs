// Local Coding Agent — AgentMemory portable backup and restore
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

export const AGENTMEMORY_BACKUP_KIND = "lca_agentmemory_backup";
export const AGENTMEMORY_BACKUP_SCHEMA = 1;
export const AGENTMEMORY_IMPORT_STRATEGIES = ["skip", "merge", "replace"];
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;

export function createAgentMemoryPortabilityPaths({ configPath, memoryCliPath }) {
  const configDirectory = path.dirname(path.resolve(configPath));
  const resolvedMemoryCliPath = path.resolve(memoryCliPath);
  return {
    configDirectory,
    backupDirectory: path.join(configDirectory, "backups"),
    serviceLogPath: path.join(configDirectory, "agentmemory-service.log"),
    serviceLockPath: path.join(configDirectory, "agentmemory-service.lock"),
    memoryCliPath: resolvedMemoryCliPath,
    memoryDirectory: findAgentMemoryRuntimeDirectory(resolvedMemoryCliPath)
  };
}


function findAgentMemoryRuntimeDirectory(cliPath) {
  let current = path.dirname(path.resolve(cliPath));
  while (true) {
    if (path.basename(current) === "agentmemory" && path.basename(path.dirname(current)) === "runtime") {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate runtime/agentmemory above ${cliPath}`);
}

export function stableStringify(value) {
  return JSON.stringify(sortJsonValue(value));
}

export function checksumExportData(exportData) {
  return createHash("sha256").update(stableStringify(exportData)).digest("hex");
}

export function summarizeAgentMemoryExport(exportData) {
  const observations = isPlainObject(exportData?.observations) ? exportData.observations : {};
  const observationCount = Object.values(observations).reduce(
    (sum, items) => sum + (Array.isArray(items) ? items.length : 0),
    0
  );
  const optionalCollections = [
    "profiles",
    "graphNodes",
    "graphEdges",
    "semanticMemories",
    "proceduralMemories",
    "actions",
    "actionEdges",
    "sentinels",
    "sketches",
    "crystals",
    "facets",
    "lessons",
    "insights",
    "routines",
    "signals",
    "checkpoints",
    "accessLogs"
  ];
  const optional = {};
  for (const key of optionalCollections) {
    if (Array.isArray(exportData?.[key])) optional[key] = exportData[key].length;
  }
  return {
    version: typeof exportData?.version === "string" ? exportData.version : null,
    sessions: Array.isArray(exportData?.sessions) ? exportData.sessions.length : 0,
    observations: observationCount,
    observation_buckets: Object.keys(observations).length,
    memories: Array.isArray(exportData?.memories) ? exportData.memories.length : 0,
    summaries: Array.isArray(exportData?.summaries) ? exportData.summaries.length : 0,
    optional
  };
}

export function validateAgentMemoryExport(exportData) {
  const errors = [];
  if (!isPlainObject(exportData)) errors.push("exportData must be an object");
  if (typeof exportData?.version !== "string" || !exportData.version.trim()) errors.push("version must be a non-empty string");
  if (!Array.isArray(exportData?.sessions)) errors.push("sessions must be an array");
  if (!isPlainObject(exportData?.observations)) errors.push("observations must be an object");
  if (!Array.isArray(exportData?.memories)) errors.push("memories must be an array");
  if (!Array.isArray(exportData?.summaries)) errors.push("summaries must be an array");

  const sessions = Array.isArray(exportData?.sessions) ? exportData.sessions : [];
  const memories = Array.isArray(exportData?.memories) ? exportData.memories : [];
  const summaries = Array.isArray(exportData?.summaries) ? exportData.summaries : [];
  const observations = isPlainObject(exportData?.observations) ? exportData.observations : {};
  if (sessions.length > 10_000) errors.push(`too many sessions: ${sessions.length}`);
  if (memories.length > 50_000) errors.push(`too many memories: ${memories.length}`);
  if (summaries.length > 10_000) errors.push(`too many summaries: ${summaries.length}`);
  if (Object.keys(observations).length > 10_000) errors.push(`too many observation buckets: ${Object.keys(observations).length}`);
  let totalObservations = 0;
  for (const [sessionId, items] of Object.entries(observations)) {
    if (!Array.isArray(items)) {
      errors.push(`observation bucket ${sessionId} must be an array`);
      continue;
    }
    if (items.length > 5_000) errors.push(`too many observations in ${sessionId}: ${items.length}`);
    totalObservations += items.length;
  }
  if (totalObservations > 500_000) errors.push(`too many total observations: ${totalObservations}`);
  return {
    ok: errors.length === 0,
    errors,
    summary: summarizeAgentMemoryExport(exportData)
  };
}

export function createAgentMemoryBackupEnvelope(exportData, options = {}) {
  const validation = validateAgentMemoryExport(exportData);
  if (!validation.ok) throw new Error(`Invalid AgentMemory export: ${validation.errors.join("; ")}`);
  const checksum = checksumExportData(exportData);
  return {
    schema: AGENTMEMORY_BACKUP_SCHEMA,
    kind: AGENTMEMORY_BACKUP_KIND,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    source: {
      lcaVersion: options.lcaVersion ?? null,
      agentmemoryVersion: exportData.version,
      platform: options.platform ?? process.platform,
      arch: options.arch ?? process.arch
    },
    counts: validation.summary,
    checksum: { algorithm: "sha256", value: checksum },
    exportData
  };
}

export function validateAgentMemoryBackupEnvelope(envelope) {
  const errors = [];
  if (!isPlainObject(envelope)) errors.push("backup must be an object");
  if (envelope?.schema !== AGENTMEMORY_BACKUP_SCHEMA) errors.push(`unsupported backup schema: ${String(envelope?.schema)}`);
  if (envelope?.kind !== AGENTMEMORY_BACKUP_KIND) errors.push(`unexpected backup kind: ${String(envelope?.kind)}`);
  if (envelope?.checksum?.algorithm !== "sha256") errors.push("checksum algorithm must be sha256");
  const exportValidation = validateAgentMemoryExport(envelope?.exportData);
  errors.push(...exportValidation.errors);
  const actualChecksum = exportValidation.ok ? checksumExportData(envelope.exportData) : null;
  if (actualChecksum && envelope?.checksum?.value !== actualChecksum) errors.push("backup checksum mismatch");
  return {
    ok: errors.length === 0,
    errors,
    checksum: actualChecksum,
    summary: exportValidation.summary,
    envelope
  };
}

export function readAgentMemoryBackup(filePath) {
  const absolute = path.resolve(filePath);
  const info = statSync(absolute);
  if (!info.isFile()) throw new Error(`AgentMemory backup is not a file: ${absolute}`);
  if (info.size > MAX_BACKUP_BYTES) throw new Error(`AgentMemory backup exceeds ${MAX_BACKUP_BYTES} bytes: ${info.size}`);
  const envelope = JSON.parse(readFileSync(absolute, "utf8"));
  const validation = validateAgentMemoryBackupEnvelope(envelope);
  if (!validation.ok) throw new Error(`Invalid AgentMemory backup: ${validation.errors.join("; ")}`);
  return { path: absolute, bytes: info.size, ...validation };
}

export async function exportAgentMemoryBackup(options) {
  await options.service.ensureReady();
  const exportData = await requestJson(options.fetch ?? fetch, `${stripSlash(options.baseUrl)}/agentmemory/export`, {
    method: "GET",
    headers: apiHeaders(options.secret)
  }, options.timeoutMs ?? 60_000);
  const envelope = createAgentMemoryBackupEnvelope(exportData, options);
  const requestedPath = path.resolve(options.outputPath ?? defaultBackupPath(options.paths.backupDirectory, options.now));
  const outputPath = options.outputPath ? requestedPath : availableBackupPath(requestedPath);
  writeJsonAtomic(outputPath, envelope);
  const bytes = statSync(outputPath).size;
  return {
    kind: "agentmemory_export",
    path: outputPath,
    bytes,
    checksum: envelope.checksum.value,
    createdAt: envelope.createdAt,
    counts: envelope.counts,
    version: envelope.source.agentmemoryVersion
  };
}

export async function importAgentMemoryBackup(options) {
  const strategy = normalizeStrategy(options.strategy);
  const backup = readAgentMemoryBackup(options.inputPath);
  const dryRunReceipt = {
    kind: "agentmemory_import",
    dry_run: options.dryRun === true,
    input: backup.path,
    bytes: backup.bytes,
    checksum: backup.checksum,
    strategy,
    counts: backup.summary,
    source: backup.envelope.source
  };
  if (options.dryRun === true) return { ...dryRunReceipt, validated: true, pre_import_backup: null, result: null };

  await options.service.ensureReady();
  const preImport = await exportAgentMemoryBackup({
    ...options,
    outputPath: options.preImportBackupPath ?? availableBackupPath(defaultPreImportPath(options.paths.backupDirectory, options.now))
  });
  const result = await requestJson(options.fetch ?? fetch, `${stripSlash(options.baseUrl)}/agentmemory/import`, {
    method: "POST",
    headers: apiHeaders(options.secret, true),
    body: JSON.stringify({ exportData: backup.envelope.exportData, strategy })
  }, options.timeoutMs ?? 120_000);
  if (result?.success !== true) throw new Error(`AgentMemory import failed: ${result?.error || JSON.stringify(result)}`);
  return {
    ...dryRunReceipt,
    validated: true,
    pre_import_backup: preImport,
    result
  };
}

export async function agentMemoryPortabilityStatus(options) {
  const backups = listBackups(options.paths.backupDirectory);
  const health = await options.service.health();
  return {
    kind: "agentmemory_portability_status",
    service: health,
    backup_directory: options.paths.backupDirectory,
    backups
  };
}

export class ManagedAgentMemoryService {
  constructor(options) {
    this.paths = options.paths;
    this.baseUrl = stripSlash(options.baseUrl ?? "http://127.0.0.1:3111");
    this.fetchImpl = options.fetch ?? fetch;
    this.spawnImpl = options.spawn ?? spawn;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.pollMs = options.pollMs ?? 250;
  }

  async health() {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/agentmemory/livez`, {
        signal: AbortSignal.timeout(2_000)
      });
      const body = response.ok ? await response.json() : null;
      return {
        ready: response.ok && body?.status === "ok",
        status: body?.status ?? null,
        version: body?.version ?? null,
        error: response.ok ? null : `HTTP ${response.status}`
      };
    } catch (error) {
      return { ready: false, status: null, version: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async ensureReady() {
    const current = await this.health();
    if (current.ready) return current;
    if (!existsSync(this.paths.memoryCliPath)) throw new Error(`AgentMemory CLI is missing: ${this.paths.memoryCliPath}`);
    mkdirSync(this.paths.configDirectory, { recursive: true });

    let ownsLock = false;
    try {
      mkdirSync(this.paths.serviceLockPath);
      ownsLock = true;
      writeFileSync(path.join(this.paths.serviceLockPath, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const ageMs = Date.now() - statSync(this.paths.serviceLockPath).mtimeMs;
        if (ageMs > Math.max(60_000, this.timeoutMs * 2)) {
          rmSync(this.paths.serviceLockPath, { recursive: true, force: true });
          return this.ensureReady();
        }
      } catch {
        // Another process may have released the lock between checks.
      }
    }

    if (ownsLock) {
      try {
        const afterLock = await this.health();
        if (!afterLock.ready) this.startDetached();
        return await this.waitForReady();
      } finally {
        rmSync(this.paths.serviceLockPath, { recursive: true, force: true });
      }
    }
    return this.waitForReady();
  }

  startDetached() {
    const fd = openSync(this.paths.serviceLogPath, "a", 0o600);
    try {
      const child = this.spawnImpl(process.execPath, [this.paths.memoryCliPath], {
        cwd: this.paths.memoryDirectory,
        env: { ...process.env, CI: "1", AGENTMEMORY_USE_DOCKER: "1" },
        detached: true,
        windowsHide: true,
        stdio: ["ignore", fd, fd]
      });
      child.unref?.();
    } finally {
      closeSync(fd);
    }
  }

  async waitForReady() {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const health = await this.health();
      if (health.ready) return health;
      await delay(this.pollMs);
    }
    throw new Error(`AgentMemory did not become ready at ${this.baseUrl} within ${this.timeoutMs}ms. See ${this.paths.serviceLogPath}`);
  }
}

function normalizeStrategy(value) {
  const strategy = String(value ?? "skip").toLowerCase();
  if (!AGENTMEMORY_IMPORT_STRATEGIES.includes(strategy)) {
    throw new Error(`AgentMemory import strategy must be one of: ${AGENTMEMORY_IMPORT_STRATEGIES.join(", ")}`);
  }
  return strategy;
}

function listBackups(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      const info = statSync(file);
      return { path: file, bytes: info.size, modifiedAt: info.mtime.toISOString() };
    })
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
    .slice(0, 50);
}


function availableBackupPath(requestedPath) {
  if (!existsSync(requestedPath)) return requestedPath;
  const parsed = path.parse(requestedPath);
  for (let index = 1; index < 10_000; index++) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a unique AgentMemory backup path near ${requestedPath}`);
}

function defaultBackupPath(directory, now) {
  return path.join(directory, `agentmemory-${timestampForFile((now ?? (() => new Date()))())}.json`);
}

function defaultPreImportPath(directory, now) {
  return path.join(directory, `agentmemory-pre-import-${timestampForFile((now ?? (() => new Date()))())}.json`);
}

function timestampForFile(value) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, file);
}

function apiHeaders(secret, jsonBody = false) {
  const headers = { Accept: "application/json", "X-AgentMemory-Source": "lca-portability" };
  if (jsonBody) headers["Content-Type"] = "application/json";
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return headers;
}

async function requestJson(fetchImpl, url, init, timeoutMs) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`AgentMemory request failed with ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`);
  }
  return response.json();
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])]));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stripSlash(value) {
  return String(value || "http://127.0.0.1:3111").replace(/\/$/, "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
