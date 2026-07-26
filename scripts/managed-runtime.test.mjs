import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createManagedRuntimePaths,
  expectedLockedVersions,
  installManagedRuntime,
  managedRuntimeFingerprint,
  runtimeInstallPlan
} from "./managed-runtime.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "lca-managed-runtime-"));
  const configPath = path.join(root, "config", "cli-config.json");
  const paths = createManagedRuntimePaths({ repoRoot: root, configPath, homeDirectory: path.join(root, "home"), platform: "linux" });
  mkdirSync(paths.serverDirectory, { recursive: true });
  mkdirSync(paths.memoryDirectory, { recursive: true });
  writeFileSync(paths.serverPackagePath, JSON.stringify({ dependencies: { demo: "^1.0.0" } }));
  writeFileSync(paths.serverLockPath, JSON.stringify({ packages: { "node_modules/demo": { version: "1.2.3" } } }));
  writeFileSync(paths.memoryPackagePath, JSON.stringify({ dependencies: { memory: "2.0.0" } }));
  writeFileSync(paths.memoryLockPath, JSON.stringify({ packages: { "node_modules/memory": { version: "2.0.0" } } }));
  writeFileSync(paths.memoryNpmrcPath, "omit=optional\n");
  return { root, paths };
}

test("derives isolated managed runtime paths", () => {
  const { root, paths } = fixture();
  try {
    assert.equal(paths.serverDirectory, path.join(root, "server"));
    assert.equal(paths.memoryDirectory, path.join(root, "runtime", "agentmemory"));
    assert.equal(paths.statePath, path.join(root, "config", "managed-runtime.json"));
    assert.match(paths.codegraphBinaryPath, /node_modules\/\.bin\/codegraph$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads exact installed expectations from lockfiles", () => {
  const { root, paths } = fixture();
  try {
    assert.deepEqual(expectedLockedVersions(paths.serverPackagePath, paths.serverLockPath), { demo: "1.2.3" });
    assert.deepEqual(expectedLockedVersions(paths.memoryPackagePath, paths.memoryLockPath), { memory: "2.0.0" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fingerprint changes when either runtime lock changes", () => {
  const { root, paths } = fixture();
  try {
    const first = managedRuntimeFingerprint(paths);
    writeFileSync(paths.memoryLockPath, JSON.stringify({ packages: { "node_modules/memory": { version: "2.0.1" } } }));
    assert.notEqual(managedRuntimeFingerprint(paths), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install plan repairs only missing runtime layers and always rebuilds", () => {
  const report = {
    checks: [
      { id: "runtime_state", status: "pass" },
      { id: "server_dependencies", status: "pass" },
      { id: "codegraph", status: "pass" },
      { id: "agentmemory_dependencies", status: "fail" },
      { id: "agentmemory_cli", status: "fail" },
      { id: "agentmemory_patches", status: "fail" },
      { id: "agentmemory_config", status: "fail" }
    ]
  };
  assert.deepEqual(runtimeInstallPlan(report), {
    installServer: false,
    installAgentMemory: true,
    patchAgentMemory: true,
    buildCompactRuntime: true,
    initializeAgentMemory: true
  });
});

test("force install refreshes both dependency trees", () => {
  const report = { checks: [] };
  const plan = runtimeInstallPlan(report, { force: true });
  assert.equal(plan.installServer, true);
  assert.equal(plan.installAgentMemory, true);
  assert.equal(plan.patchAgentMemory, true);
  assert.equal(plan.buildCompactRuntime, true);
  assert.equal(plan.initializeAgentMemory, true);
});

test("installs both managed runtime layers once and is idempotent", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lca-managed-install-"));
  const configPath = path.join(root, "config", "cli-config.json");
  const homeDirectory = path.join(root, "home");
  const paths = createManagedRuntimePaths({ repoRoot: root, configPath, homeDirectory, platform: "linux" });
  try {
    mkdirSync(paths.serverDirectory, { recursive: true });
    mkdirSync(paths.memoryDirectory, { recursive: true });
    writeFileSync(paths.serverPackagePath, JSON.stringify({
      dependencies: {
        "@colbymchenry/codegraph": "1.5.0",
        "@modelcontextprotocol/sdk": "1.29.0"
      }
    }));
    writeFileSync(paths.serverLockPath, JSON.stringify({ packages: {
      "node_modules/@colbymchenry/codegraph": { version: "1.5.0" },
      "node_modules/@modelcontextprotocol/sdk": { version: "1.29.0" }
    } }));
    writeFileSync(paths.memoryPackagePath, JSON.stringify({ dependencies: {
      "@agentmemory/agentmemory": "0.9.28"
    } }));
    writeFileSync(paths.memoryLockPath, JSON.stringify({ packages: {
      "node_modules/@agentmemory/agentmemory": { version: "0.9.28" }
    } }));
    writeFileSync(paths.memoryNpmrcPath, "omit=optional\n");

    const actions = [];
    const run = async (command, args, options = {}) => {
      actions.push({ command, args: [...args], cwd: options.cwd });
      if (options.cwd === paths.serverDirectory && args[0] === "ci") {
        for (const [name, version] of Object.entries({
          "@colbymchenry/codegraph": "1.5.0",
          "@modelcontextprotocol/sdk": "1.29.0"
        })) {
          const packageDirectory = path.join(paths.serverDirectory, "node_modules", ...name.split("/"));
          mkdirSync(packageDirectory, { recursive: true });
          writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({ name, version }));
        }
        mkdirSync(path.dirname(paths.codegraphBinaryPath), { recursive: true });
        writeFileSync(paths.codegraphBinaryPath, "codegraph");
      }
      if (options.cwd === paths.memoryDirectory && args[0] === "ci") {
        const packageDirectory = path.join(paths.memoryDirectory, "node_modules", "@agentmemory", "agentmemory");
        mkdirSync(path.join(packageDirectory, "dist"), { recursive: true });
        writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({ name: "@agentmemory/agentmemory", version: "0.9.28" }));
        writeFileSync(paths.memoryCliPath, "// cli\n");
        const runtimeFixture = [
          "function registerEventTriggers(sdk, kv) {",
          "\tsdk.registerFunction(\"event::session::stopped\", async (data) => {",
          "\t\tconst summary = await sdk.trigger({",
          "\t\t\tfunction_id: \"mem::summarize\",",
          "\t\t\tpayload: data",
          "\t\t});",
          "\t\treturn summary;",
          "\t});",
          "}",
          "\tregisterEventTriggers(sdk, kv);",
          ""
        ].join("\n");
        writeFileSync(path.join(packageDirectory, "dist", "index.mjs"), runtimeFixture);
        writeFileSync(path.join(packageDirectory, "dist", "src-CzgoepGU.mjs"), runtimeFixture);
      }
      if (options.cwd === paths.serverDirectory && args.includes("build:next")) {
        mkdirSync(path.dirname(paths.compactEntryPath), { recursive: true });
        writeFileSync(paths.compactEntryPath, "export {};\n");
      }
      if (command === process.execPath && args.at(-1) === "init") {
        mkdirSync(path.dirname(paths.memoryEnvPath), { recursive: true });
        writeFileSync(paths.memoryEnvPath, "# zero-LLM\n");
      }
      return { code: 0, signal: null, stdout: "", stderr: "" };
    };
    const capture = async (command, args) => {
      if (String(command).endsWith("codegraph") && args[0] === "--version") {
        return { code: 0, signal: null, stdout: "1.5.0\n", stderr: "" };
      }
      if (command === "npm" && args[0] === "--version") {
        return { code: 0, signal: null, stdout: "10.8.2\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "--version") {
        return { code: 0, signal: null, stdout: "Docker version 29.6.2\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "info") {
        return { code: 0, signal: null, stdout: '"29.6.2"\n', stderr: "" };
      }
      return { code: 127, signal: null, stdout: "", stderr: "not found" };
    };

    const first = await installManagedRuntime({
      paths,
      platform: "linux",
      arch: "x64",
      nodeVersion: "20.20.2",
      run,
      capture,
      fetch: async () => new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    });
    assert.equal(first.after.ready, true);
    assert.deepEqual(first.plan, {
      installServer: true,
      installAgentMemory: true,
      patchAgentMemory: true,
      buildCompactRuntime: true,
      initializeAgentMemory: true
    });
    assert.equal(existsSync(paths.statePath), true);
    assert.equal(existsSync(paths.compactEntryPath), true);
    assert.equal(existsSync(paths.memoryEnvPath), true);

    actions.length = 0;
    const second = await installManagedRuntime({
      paths,
      platform: "linux",
      arch: "x64",
      nodeVersion: "20.20.2",
      run,
      capture,
      fetch: async () => new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    });
    assert.equal(second.plan.installServer, false);
    assert.equal(second.plan.installAgentMemory, false);
    assert.equal(second.plan.patchAgentMemory, false);
    assert.equal(second.plan.initializeAgentMemory, false);
    assert.deepEqual(actions.map((action) => action.args), [["run", "build:next"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
