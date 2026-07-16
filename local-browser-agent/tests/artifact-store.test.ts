import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ArtifactStore } from "../apps/server/src/captures/artifact-store.js";
import type { CapturePayload } from "../packages/protocol/src/index.js";

function payload(overrides: Partial<CapturePayload> = {}): CapturePayload {
  return {
    tab: {
      id: 1,
      windowId: 1,
      active: true,
      title: "Example",
      url: "https://example.test/?token=private",
      origin: "https://example.test",
      incognito: false,
      status: "complete"
    },
    mode: "agent",
    capturedAt: new Date().toISOString(),
    coverage: {},
    warnings: [],
    ...overrides
  };
}

test("artifact store redacts JSON and validates resource paths", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lba-artifacts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ArtifactStore(dir, 1_000_000, 60_000);
  await store.init();
  const stored = await store.save(payload({
    html: {
      markup: '<!doctype html><html><body><a href="https://example.test/?token=private">Example</a></body></html>',
      baseUrl: "https://example.test/",
      title: "Example",
      truncated: false,
      originalChars: 100,
      capturedAt: new Date().toISOString(),
      sanitization: { scriptsRemoved: true }
    },
    network: [{ url: "https://api.test/?api_key=secret", requestHeaders: [{ name: "Authorization", value: "Bearer abcdefghijklmnop" }] }]
  }), true);
  const manifest = await store.readManifest(stored.captureId);
  assert.match(manifest.tab.url, /%5Bredacted%5D/);
  const network = await store.readArtifact(stored.captureId, "network.json");
  const text = network.data.toString("utf8");
  assert.ok(!text.includes("abcdefghijklmnop"));
  assert.ok(!text.includes("api_key=secret"));
  const page = await store.readArtifact(stored.captureId, "page.html");
  assert.equal(page.descriptor.mediaType, "text/html");
  assert.ok(!page.data.toString("utf8").includes("token=private"));
  await assert.rejects(() => store.readArtifact(stored.captureId, "../manifest.json"), /Invalid artifact name/);
  await assert.rejects(() => store.readManifest("../../outside"), /Invalid capture id/);
});

test("failed oversized captures are removed transactionally", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lba-artifacts-small-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ArtifactStore(dir, 32, 60_000);
  await store.init();
  await assert.rejects(() => store.save(payload({ dom: { text: "x".repeat(1000) } }), true), /exceeds/);
  assert.deepEqual(await readdir(dir), []);
});

test("expired captures are purged", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lba-artifacts-expire-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ArtifactStore(dir, 1_000_000, 1);
  await store.init();
  await store.save(payload({ dom: { ok: true } }), true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await store.cleanupExpired(), 1);
  assert.deepEqual(await readdir(dir), []);
});
