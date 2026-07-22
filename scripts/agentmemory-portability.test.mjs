import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AGENTMEMORY_BACKUP_KIND,
  ManagedAgentMemoryService,
  checksumExportData,
  createAgentMemoryBackupEnvelope,
  createAgentMemoryPortabilityPaths,
  exportAgentMemoryBackup,
  importAgentMemoryBackup,
  readAgentMemoryBackup,
  stableStringify,
  validateAgentMemoryBackupEnvelope
} from "./agentmemory-portability.mjs";

function sampleExport() {
  return {
    version: "0.9.28",
    exportedAt: "2026-07-22T00:00:00.000Z",
    sessions: [{ id: "session-one", project: "demo" }],
    observations: { "session-one": [{ id: "obs-one" }] },
    memories: [{ id: "mem-one", content: "decision", sessionIds: [] }],
    summaries: []
  };
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "lca-memory-portability-"));
  const paths = createAgentMemoryPortabilityPaths({
    configPath: path.join(root, "config", "cli-config.json"),
    memoryCliPath: path.join(root, "runtime", "agentmemory", "dist", "cli.mjs")
  });
  return { root, paths };
}


test("derives the companion runtime directory from the pinned CLI path", () => {
  const { root, paths } = fixture();
  try {
    assert.equal(paths.memoryDirectory, path.join(root, "runtime", "agentmemory"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stable checksum ignores object key order", () => {
  const left = { b: 2, a: { y: 2, x: 1 } };
  const right = { a: { x: 1, y: 2 }, b: 2 };
  assert.equal(stableStringify(left), stableStringify(right));
  assert.equal(checksumExportData(left), checksumExportData(right));
});

test("backup validation detects tampering", () => {
  const envelope = createAgentMemoryBackupEnvelope(sampleExport(), {
    now: () => new Date("2026-07-22T00:00:00.000Z"),
    lcaVersion: "4.4.0-pro"
  });
  assert.equal(envelope.kind, AGENTMEMORY_BACKUP_KIND);
  assert.equal(validateAgentMemoryBackupEnvelope(envelope).ok, true);
  envelope.exportData.memories[0].content = "tampered";
  assert.match(validateAgentMemoryBackupEnvelope(envelope).errors.join(" "), /checksum mismatch/);
});

test("exports a private atomic backup with bounded receipt", async () => {
  const { root, paths } = fixture();
  try {
    let readyCalls = 0;
    const output = path.join(root, "backup.json");
    const receipt = await exportAgentMemoryBackup({
      paths,
      baseUrl: "http://memory.test",
      outputPath: output,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      lcaVersion: "4.4.0-pro",
      service: { async ensureReady() { readyCalls += 1; } },
      fetch: async () => new Response(JSON.stringify(sampleExport()), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    });
    assert.equal(readyCalls, 1);
    assert.equal(receipt.path, output);
    assert.equal(receipt.counts.sessions, 1);
    assert.equal(receipt.counts.observations, 1);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(readAgentMemoryBackup(output).summary.memories, 1);
    assert.equal(readFileSync(output, "utf8").includes("decision"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run import validates offline without touching the API", async () => {
  const { root, paths } = fixture();
  try {
    const input = path.join(root, "input.json");
    const envelope = createAgentMemoryBackupEnvelope(sampleExport());
    await exportAgentMemoryBackup({
      paths,
      baseUrl: "http://memory.test",
      outputPath: input,
      service: { async ensureReady() {} },
      fetch: async () => new Response(JSON.stringify(sampleExport()), { status: 200, headers: { "content-type": "application/json" } })
    });
    let touched = false;
    const receipt = await importAgentMemoryBackup({
      paths,
      baseUrl: "http://memory.test",
      inputPath: input,
      dryRun: true,
      service: { async ensureReady() { touched = true; } },
      fetch: async () => { touched = true; return new Response(); }
    });
    assert.equal(receipt.validated, true);
    assert.equal(receipt.strategy, "skip");
    assert.equal(receipt.pre_import_backup, null);
    assert.equal(touched, false);
    assert.equal(envelope.kind, AGENTMEMORY_BACKUP_KIND);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real import creates a pre-import backup and uses the selected strategy", async () => {
  const { root, paths } = fixture();
  try {
    const input = path.join(root, "input.json");
    const preImport = path.join(root, "pre-import.json");
    await exportAgentMemoryBackup({
      paths,
      baseUrl: "http://memory.test",
      outputPath: input,
      service: { async ensureReady() {} },
      fetch: async () => new Response(JSON.stringify(sampleExport()), { status: 200, headers: { "content-type": "application/json" } })
    });
    const requests = [];
    const receipt = await importAgentMemoryBackup({
      paths,
      baseUrl: "http://memory.test",
      inputPath: input,
      preImportBackupPath: preImport,
      strategy: "merge",
      service: { async ensureReady() {} },
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (String(url).endsWith("/export")) {
          return new Response(JSON.stringify(sampleExport()), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ success: true, strategy: "merge", sessions: 1, observations: 1, memories: 1, summaries: 0, skipped: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });
    assert.equal(existsSync(preImport), true);
    assert.equal(receipt.strategy, "merge");
    assert.equal(receipt.result.success, true);
    assert.deepEqual(requests.map((request) => request.method), ["GET", "POST"]);
    assert.equal(requests[1].body.strategy, "merge");
    assert.equal(requests[1].body.exportData.version, "0.9.28");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed portability service reuses a healthy daemon", async () => {
  const { root, paths } = fixture();
  try {
    let spawns = 0;
    const service = new ManagedAgentMemoryService({
      paths,
      baseUrl: "http://memory.test",
      fetch: async () => new Response(JSON.stringify({ status: "ok", version: "0.9.28" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }),
      spawn: () => { spawns += 1; return { unref() {} }; }
    });
    const health = await service.ensureReady();
    assert.equal(health.ready, true);
    assert.equal(spawns, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("default backup names never overwrite an existing same-second export", async () => {
  const { root, paths } = fixture();
  try {
    const now = () => new Date("2026-07-22T12:34:56.000Z");
    const common = {
      paths,
      baseUrl: "http://memory.test",
      now,
      service: { async ensureReady() {} },
      fetch: async () => new Response(JSON.stringify(sampleExport()), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    };
    const first = await exportAgentMemoryBackup(common);
    const second = await exportAgentMemoryBackup(common);
    assert.notEqual(first.path, second.path);
    assert.equal(existsSync(first.path), true);
    assert.equal(existsSync(second.path), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
