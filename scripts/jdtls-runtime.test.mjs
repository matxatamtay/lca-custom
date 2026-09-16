import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createJdtLsRuntimePaths,
  inspectJdtLsRuntime,
  installJdtLsRuntime,
  resolveTarCommand
} from "./jdtls-runtime.mjs";

test("JDT LS runtime paths stay isolated under runtime/jdtls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-jdtls-paths-"));
  try {
    const paths = createJdtLsRuntimePaths({ repoRoot: root, platform: "darwin", version: "9.9.9" });
    assert.equal(paths.versionDirectory, path.join(root, "runtime", "jdtls", "9.9.9"));
    assert.equal(paths.binaryPath, path.join(root, "runtime", "jdtls", "9.9.9", "bin", "jdtls"));
    assert.equal(inspectJdtLsRuntime({ paths, version: "9.9.9", sha256: "abc" }).installed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer verifies checksum and atomically installs an isolated JDT LS runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-jdtls-install-"));
  const archive = Buffer.from("fake-jdtls-archive");
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const paths = createJdtLsRuntimePaths({ repoRoot: root, platform: "darwin", version: "9.9.9" });
  const fetchImpl = async () => new Response(archive, { status: 200 });
  const run = async (_command, args) => {
    const target = args[args.indexOf("-C") + 1];
    mkdirSync(path.join(target, "bin"), { recursive: true });
    writeFileSync(path.join(target, "bin", "jdtls"), "#!/bin/sh\n", "utf8");
    return { code: 0, stdout: "", stderr: "" };
  };

  try {
    const installed = await installJdtLsRuntime({
      paths,
      version: "9.9.9",
      url: "https://example.test/jdtls.tar.gz",
      sha256,
      fetch: fetchImpl,
      run,
      platform: "darwin"
    });
    assert.equal(installed.changed, true);
    assert.equal(installed.status.installed, true);
    assert.equal(existsSync(paths.binaryPath), true);

    const reused = await installJdtLsRuntime({
      paths,
      version: "9.9.9",
      url: "https://example.test/jdtls.tar.gz",
      sha256,
      fetch: async () => { throw new Error("should not download"); },
      run,
      platform: "darwin"
    });
    assert.equal(reused.changed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer rejects a bad JDT LS checksum without publishing the runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-jdtls-checksum-"));
  const paths = createJdtLsRuntimePaths({ repoRoot: root, platform: "darwin", version: "9.9.9" });
  try {
    await assert.rejects(
      installJdtLsRuntime({
        paths,
        version: "9.9.9",
        url: "https://example.test/jdtls.tar.gz",
        sha256: "0".repeat(64),
        fetch: async () => new Response(Buffer.from("wrong"), { status: 200 }),
        run: async () => { throw new Error("must not extract"); },
        platform: "darwin"
      }),
      /checksum mismatch/
    );
    assert.equal(existsSync(paths.versionDirectory), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tar command follows the host platform", () => {
  assert.equal(resolveTarCommand("darwin"), "tar");
  assert.equal(resolveTarCommand("linux"), "tar");
  assert.equal(resolveTarCommand("win32"), "tar.exe");
});
