import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";

import type { LspClientLike } from "../../infrastructure/lsp/stdio-lsp-client.js";
import { DartSemanticEngine, resolveDartExecutable } from "./dart-semantic-engine.js";
import type { SemanticEngineResult } from "./semantic-context-adapter.js";

function semanticResult(value: Awaited<ReturnType<DartSemanticEngine["context"]>>): SemanticEngineResult {
  assert.ok(!Array.isArray(value));
  return value as SemanticEngineResult;
}

class FakeLspClient implements LspClientLike {
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  private readonly listeners = new Set<(method: string, params: unknown) => void>();

  constructor(private readonly fileUri: string) {}

  async start(): Promise<void> {}

  async request(method: string, _params: unknown): Promise<unknown> {
    if (method === "initialize") return { capabilities: {} };
    if (method === "workspace/symbol") {
      return [{
        name: "ScanViewModel",
        kind: 5,
        location: {
          uri: this.fileUri,
          range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } }
        }
      }];
    }
    if (method === "textDocument/definition") {
      return [{ uri: this.fileUri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 19 } } }];
    }
    if (method === "textDocument/references") {
      return [{ uri: this.fileUri, range: { start: { line: 2, character: 10 }, end: { line: 2, character: 23 } } }];
    }
    if (method === "shutdown") return null;
    return null;
  }

  notify(method: string, params: unknown): void {
    this.notifications.push({ method, params });
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(method: string, params: unknown): void {
    for (const listener of this.listeners) listener(method, params);
  }

  async close(): Promise<void> {}
}

test("resolves Dart from a project-local FVM Flutter SDK", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-dart-resolve-"));
  const executable = process.platform === "win32" ? "dart.exe" : "dart";
  const expected = path.join(root, ".fvm", "flutter_sdk", "bin", executable);
  try {
    await mkdir(path.dirname(expected), { recursive: true });
    await writeFile(expected, "fake", "utf8");
    assert.equal(await resolveDartExecutable(root, { PATH: "" }, path.join(root, "home")), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves Dart from configured FVM cache using .fvmrc", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-dart-fvm-cache-"));
  const cache = path.join(root, "cache");
  const executable = process.platform === "win32" ? "dart.exe" : "dart";
  const expected = path.join(cache, "versions", "3.38.5", "bin", executable);
  try {
    await mkdir(path.dirname(expected), { recursive: true });
    await writeFile(path.join(root, ".fvmrc"), JSON.stringify({ flutter: "3.38.5" }), "utf8");
    await writeFile(expected, "fake", "utf8");
    assert.equal(await resolveDartExecutable(root, { PATH: "", FVM_CACHE_PATH: cache }, path.join(root, "home")), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Dart semantic context warms in background and only queries after analyzer readiness", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-dart-semantic-"));
  const file = path.join(root, "lib", "scan_view_model.dart");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, [
    "class ScanViewModel {",
    "  void scan() {}",
    "  final ScanViewModel self = ScanViewModel();",
    "}",
    ""
  ].join("\n"), "utf8");
  let fake: FakeLspClient | undefined;
  const engine = new DartSemanticEngine({
    resolveDartExecutable: async () => "/fake/dart",
    createClient: () => {
      fake = new FakeLspClient(pathToFileURL(file).toString());
      return fake;
    },
    queryTimeoutMs: 100,
    warmupTimeoutMs: 5_000,
    readyQuietPeriodMs: 0
  });

  try {
    const first = semanticResult(await engine.context({ task: "Trace ScanViewModel references", root }));
    assert.equal(first.state, "warming");
    assert.equal(first.evidence.length, 0);

    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(fake);
    fake.emit("$/progress", { token: "ANALYZING", value: { kind: "begin", title: "Analyzing…" } });
    const stillWarming = semanticResult(await engine.context({ task: "Trace ScanViewModel references", root }));
    assert.equal(stillWarming.state, "warming");

    fake.emit("$/progress", { token: "ANALYZING", value: { kind: "end" } });
    let ready = semanticResult(await engine.context({
      task: "Trace ScanViewModel references",
      root,
      changedFiles: ["lib/scan_view_model.dart"]
    }));
    const readyDeadline = Date.now() + 1_000;
    while (ready.state === "warming" && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      ready = semanticResult(await engine.context({
        task: "Trace ScanViewModel references",
        root,
        changedFiles: ["lib/scan_view_model.dart"]
      }));
    }
    assert.equal(ready.state, "ready");
    assert.equal(ready.evidence.length, 1);
    assert.equal(ready.evidence[0]?.symbol, "ScanViewModel");
    assert.match(ready.evidence[0]?.content ?? "", /lib\/scan_view_model\.dart:1:7/);
    assert.match(ready.evidence[0]?.content ?? "", /References \(1\)/);
    assert.ok(fake.notifications.some((item) => item.method === "workspace/didChangeWatchedFiles"));
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Dart semantic context never returns an unrelated workspace symbol", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-dart-unrelated-"));
  const file = path.join(root, "lib", "scan_view_model.dart");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "class ScanViewModel {}\n", "utf8");
  let fake: FakeLspClient | undefined;
  const engine = new DartSemanticEngine({
    resolveDartExecutable: async () => "/fake/dart",
    createClient: () => {
      fake = new FakeLspClient(pathToFileURL(file).toString());
      return fake;
    },
    queryTimeoutMs: 100,
    warmupTimeoutMs: 5_000,
    readyQuietPeriodMs: 0
  });

  try {
    const first = semanticResult(await engine.context({ task: "RemoteConfigModel", root }));
    assert.equal(first.state, "warming");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(fake);
    fake.emit("$/progress", { token: "ANALYZING", value: { kind: "end" } });

    let result = semanticResult(await engine.context({ task: "RemoteConfigModel", root }));
    const readyDeadline = Date.now() + 1_000;
    while (result.state === "warming" && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      result = semanticResult(await engine.context({ task: "RemoteConfigModel", root }));
    }

    assert.equal(result.state, "ready");
    assert.deepEqual(result.evidence, []);
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});
