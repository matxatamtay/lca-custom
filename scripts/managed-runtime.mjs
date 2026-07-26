// Local Coding Agent — managed runtime installer and doctor
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyAgentMemoryRuntimePatches,
  inspectAgentMemoryRuntimePatches
} from "./agentmemory-runtime-patches.mjs";

export const MIN_NODE_MAJOR = 20;
export const EXPECTED_III_ENGINE_VERSION = "0.11.2";

export function createManagedRuntimePaths({
  repoRoot,
  configPath,
  homeDirectory = os.homedir(),
  platform = process.platform
}) {
  const root = path.resolve(repoRoot);
  const serverDirectory = path.join(root, "server");
  const memoryDirectory = path.join(root, "runtime", "agentmemory");
  const executableSuffix = platform === "win32" ? ".cmd" : "";
  const nativeSuffix = platform === "win32" ? ".exe" : "";
  return {
    repoRoot: root,
    configDirectory: path.dirname(path.resolve(configPath)),
    statePath: path.join(path.dirname(path.resolve(configPath)), "managed-runtime.json"),
    serverDirectory,
    serverPackagePath: path.join(serverDirectory, "package.json"),
    serverLockPath: path.join(serverDirectory, "package-lock.json"),
    compactEntryPath: path.join(serverDirectory, "dist", "interfaces", "mcp", "compact-mcp-interface.js"),
    codegraphBinaryPath: path.join(serverDirectory, "node_modules", ".bin", `codegraph${executableSuffix}`),
    memoryDirectory,
    memoryPackagePath: path.join(memoryDirectory, "package.json"),
    memoryLockPath: path.join(memoryDirectory, "package-lock.json"),
    memoryNpmrcPath: path.join(memoryDirectory, ".npmrc"),
    memoryPatchModulePath: path.join(root, "scripts", "agentmemory-runtime-patches.mjs"),
    memoryCliPath: path.join(memoryDirectory, "node_modules", "@agentmemory", "agentmemory", "dist", "cli.mjs"),
    memoryEnvPath: path.join(homeDirectory, ".agentmemory", ".env"),
    privateIiiPath: path.join(homeDirectory, ".agentmemory", "bin", `iii${nativeSuffix}`)
  };
}

export function managedRuntimeFingerprint(paths) {
  const hash = createHash("sha256");
  for (const file of [
    paths.serverPackagePath,
    paths.serverLockPath,
    paths.memoryPackagePath,
    paths.memoryLockPath,
    paths.memoryNpmrcPath,
    paths.memoryPatchModulePath
  ]) {
    hash.update(path.basename(file));
    hash.update("\0");
    hash.update(existsSync(file) ? readFileSync(file) : Buffer.from("missing"));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 24);
}

export function expectedLockedVersions(packagePath, lockPath) {
  const manifest = readJsonFile(packagePath);
  const lock = readJsonFile(lockPath);
  const requested = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {})
  };
  const expected = {};
  for (const name of Object.keys(requested)) {
    const version = lock.packages?.[`node_modules/${name}`]?.version;
    if (typeof version === "string" && version) expected[name] = version;
  }
  return expected;
}

export function runtimeInstallPlan(report, { force = false } = {}) {
  const failed = new Set(report.checks.filter((check) => check.status === "fail").map((check) => check.id));
  const server = force || failed.has("runtime_state") || failed.has("server_dependencies") || failed.has("codegraph");
  const memory = force || failed.has("runtime_state") || failed.has("agentmemory_dependencies") || failed.has("agentmemory_cli");
  const patchMemory = force || memory || failed.has("agentmemory_patches");
  const initializeMemory = force || failed.has("agentmemory_config");
  return {
    installServer: server,
    installAgentMemory: memory,
    patchAgentMemory: patchMemory,
    buildCompactRuntime: true,
    initializeAgentMemory: initializeMemory
  };
}

export async function inspectManagedRuntime(options) {
  const paths = options.paths;
  const capture = options.capture ?? captureCommand;
  const fetchImpl = options.fetch ?? fetch;
  const platform = options.platform ?? process.platform;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const probeEngine = options.probeEngine !== false;
  const probeServices = options.probeServices !== false;
  const memoryUrl = String(options.agentMemoryUrl ?? "http://127.0.0.1:3111").replace(/\/$/, "");
  const checks = [];
  const add = (id, status, title, detail, repair = null) => checks.push({ id, status, title, detail, repair });

  const nodeMajor = Number(String(nodeVersion).split(".")[0]);
  add(
    "node",
    Number.isInteger(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR ? "pass" : "fail",
    "Node.js runtime",
    `v${nodeVersion}`,
    `Install Node.js ${MIN_NODE_MAJOR}+.`
  );

  const npmCommand = platform === "win32" ? "npm.cmd" : "npm";
  const npm = await capture(npmCommand, ["--version"], { timeoutMs: 15_000 });
  add("npm", npm.code === 0 ? "pass" : "fail", "npm", npm.code === 0 ? npm.stdout.trim() : npm.stderr || "not found", "Install npm with Node.js.");

  const fingerprint = managedRuntimeFingerprint(paths);
  const state = readJsonFile(paths.statePath, null);
  add(
    "runtime_state",
    state?.fingerprint === fingerprint ? "pass" : "fail",
    "Managed runtime fingerprint",
    state?.fingerprint ? `${state.fingerprint} (expected ${fingerprint})` : `missing (expected ${fingerprint})`,
    "Run lca-custom install."
  );

  const serverExpected = expectedLockedVersions(paths.serverPackagePath, paths.serverLockPath);
  const serverVersions = inspectInstalledVersions(paths.serverDirectory, serverExpected);
  const serverMismatches = versionMismatches(serverExpected, serverVersions);
  add(
    "server_dependencies",
    serverMismatches.length === 0 ? "pass" : "fail",
    "Server dependencies",
    serverMismatches.length ? serverMismatches.join("; ") : summarizeVersions(serverVersions),
    "Run npm ci in server/ through lca-custom install."
  );

  const memoryExpected = expectedLockedVersions(paths.memoryPackagePath, paths.memoryLockPath);
  const memoryVersions = inspectInstalledVersions(paths.memoryDirectory, memoryExpected);
  const memoryMismatches = versionMismatches(memoryExpected, memoryVersions);
  add(
    "agentmemory_dependencies",
    memoryMismatches.length === 0 ? "pass" : "fail",
    "AgentMemory dependencies",
    memoryMismatches.length ? memoryMismatches.join("; ") : summarizeVersions(memoryVersions),
    "Run lean npm ci in runtime/agentmemory through lca-custom install."
  );

  const buildExists = existsSync(paths.compactEntryPath);
  add("compact_build", buildExists ? "pass" : "fail", "Compact TypeScript build", paths.compactEntryPath, "Run npm run build:next through lca-custom install.");

  let codegraphVersion = null;
  if (existsSync(paths.codegraphBinaryPath)) {
    const result = await capture(paths.codegraphBinaryPath, ["--version"], { cwd: paths.serverDirectory, timeoutMs: 20_000 });
    codegraphVersion = firstVersion(result.stdout || result.stderr);
  }
  const expectedCodegraph = serverExpected["@colbymchenry/codegraph"] ?? null;
  add(
    "codegraph",
    codegraphVersion && codegraphVersion === expectedCodegraph ? "pass" : "fail",
    "CodeGraph platform runtime",
    codegraphVersion ? `${codegraphVersion} (expected ${expectedCodegraph})` : `unavailable for ${platform}/${options.arch ?? process.arch}`,
    "Reinstall server dependencies on a supported platform."
  );

  const expectedAgentMemory = memoryExpected["@agentmemory/agentmemory"] ?? null;
  const installedAgentMemory = memoryVersions["@agentmemory/agentmemory"] ?? null;
  add(
    "agentmemory_cli",
    existsSync(paths.memoryCliPath) && installedAgentMemory === expectedAgentMemory ? "pass" : "fail",
    "AgentMemory CLI",
    installedAgentMemory ? `${installedAgentMemory} (expected ${expectedAgentMemory})` : paths.memoryCliPath,
    "Reinstall the managed AgentMemory runtime."
  );
  const memoryPatches = inspectAgentMemoryRuntimePatches(paths.memoryDirectory);
  add(
    "agentmemory_patches",
    memoryPatches.ok ? "pass" : "fail",
    "AgentMemory compatibility patches",
    memoryPatches.detail,
    "Run lca-custom install to reapply managed AgentMemory patches."
  );
  add(
    "agentmemory_config",
    existsSync(paths.memoryEnvPath) ? "pass" : "fail",
    "AgentMemory configuration",
    paths.memoryEnvPath,
    "Initialize the default zero-LLM AgentMemory config."
  );

  let engine = {
    strategy: "deferred",
    docker: { installed: false, ready: false, version: null },
    iii: { installed: false, compatible: false, version: null, path: null }
  };
  if (probeEngine) {
    engine = await inspectEngine({ paths, capture, platform });
    const engineStatus = engine.strategy === "docker" || engine.strategy === "iii" ? "pass" : "warn";
    add(
      "agentmemory_engine",
      engineStatus,
      "AgentMemory engine strategy",
      engine.strategy === "docker"
        ? `Docker ready: ${engine.docker.version}`
        : engine.strategy === "iii"
          ? `iii v${engine.iii.version}: ${engine.iii.path}`
          : "No ready Docker daemon or compatible iii binary; first start will try AgentMemory's pinned bootstrap.",
      engineStatus === "pass" ? null : "Start Docker or allow the first LCA context call to install iii-engine."
    );
  }

  let service = { ready: false, status: null, error: null };
  if (probeServices) {
    try {
      const response = await fetchImpl(`${memoryUrl}/agentmemory/livez`, { signal: AbortSignal.timeout(2_000) });
      const body = response.ok ? await response.json() : null;
      service = { ready: response.ok && body?.status === "ok", status: body?.status ?? null, error: response.ok ? null : `HTTP ${response.status}` };
    } catch (error) {
      service = { ready: false, status: null, error: error instanceof Error ? error.message : String(error) };
    }
    add(
      "agentmemory_service",
      service.ready ? "pass" : "warn",
      "AgentMemory service",
      service.ready ? `${memoryUrl} healthy` : `${memoryUrl} offline${service.error ? `: ${service.error}` : ""}`,
      service.ready ? null : "It will be started automatically by workspace_context."
    );
  }

  const fail = checks.filter((check) => check.status === "fail").length;
  const warn = checks.filter((check) => check.status === "warn").length;
  return {
    kind: "managed_runtime_doctor",
    status: fail ? "fail" : warn ? "warn" : "pass",
    ready: fail === 0,
    fingerprint,
    state: state ?? null,
    checks,
    summary: { pass: checks.filter((check) => check.status === "pass").length, warn, fail },
    versions: {
      node: nodeVersion,
      npm: npm.code === 0 ? npm.stdout.trim() : null,
      server: serverVersions,
      agentmemory: memoryVersions,
      codegraph: codegraphVersion
    },
    engine,
    services: { agentmemory: service }
  };
}

export async function installManagedRuntime(options) {
  const paths = options.paths;
  const capture = options.capture ?? captureCommand;
  const run = options.run ?? runCommand;
  const log = options.log ?? (() => {});
  const before = await inspectManagedRuntime({
    ...options,
    capture,
    probeEngine: false,
    probeServices: false
  });
  const prerequisiteFailures = before.checks.filter(
    (check) => (check.id === "node" || check.id === "npm") && check.status === "fail"
  );
  if (prerequisiteFailures.length > 0) {
    throw new Error(prerequisiteFailures.map((check) => `${check.title}: ${check.detail}`).join(" | "));
  }
  const plan = runtimeInstallPlan(before, { force: options.force === true });
  const npmCommand = (options.platform ?? process.platform) === "win32" ? "npm.cmd" : "npm";

  if (plan.installServer) {
    log("Installing pinned server dependencies");
    await run(npmCommand, ["ci"], { cwd: paths.serverDirectory, timeoutMs: 600_000 });
  }
  if (plan.installAgentMemory) {
    log("Installing lean AgentMemory companion runtime");
    await run(npmCommand, ["ci", "--ignore-scripts"], { cwd: paths.memoryDirectory, timeoutMs: 600_000 });
  }
  if (plan.patchAgentMemory) {
    log("Applying managed AgentMemory compatibility patches");
    applyAgentMemoryRuntimePatches(paths.memoryDirectory);
  }
  if (plan.buildCompactRuntime) {
    log("Building compact TypeScript runtime");
    await run(npmCommand, ["run", "build:next"], { cwd: paths.serverDirectory, timeoutMs: 300_000 });
  }
  if (plan.initializeAgentMemory && !existsSync(paths.memoryEnvPath)) {
    if (!existsSync(paths.memoryCliPath)) throw new Error(`AgentMemory CLI is missing after install: ${paths.memoryCliPath}`);
    log("Initializing zero-LLM AgentMemory configuration");
    await run(process.execPath, [paths.memoryCliPath, "init"], {
      cwd: paths.memoryDirectory,
      timeoutMs: 60_000,
      env: { ...process.env, CI: "1" }
    });
  }

  const fingerprint = managedRuntimeFingerprint(paths);
  mkdirSync(paths.configDirectory, { recursive: true });
  writeJsonAtomic(paths.statePath, {
    schema: 1,
    fingerprint,
    installedAt: new Date().toISOString(),
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch
  });

  const after = await inspectManagedRuntime({ ...options, capture });
  if (!after.ready) {
    const failures = after.checks.filter((check) => check.status === "fail").map((check) => `${check.title}: ${check.detail}`);
    throw new Error(`Managed runtime installation is incomplete. ${failures.join(" | ")}`);
  }
  return { before, plan, after };
}

async function inspectEngine({ paths, capture, platform }) {
  const dockerCommand = platform === "win32" ? "docker.exe" : "docker";
  const dockerVersionResult = await capture(dockerCommand, ["--version"], { timeoutMs: 15_000 });
  const dockerVersion = firstVersion(dockerVersionResult.stdout || dockerVersionResult.stderr);
  let dockerReady = false;
  if (dockerVersionResult.code === 0) {
    const info = await capture(dockerCommand, ["info", "--format", "{{json .ServerVersion}}"], { timeoutMs: 20_000 });
    dockerReady = info.code === 0 && Boolean(info.stdout.trim());
  }

  let iiiPath = existsSync(paths.privateIiiPath) ? paths.privateIiiPath : platform === "win32" ? "iii.exe" : "iii";
  let iiiResult = await capture(iiiPath, ["--version"], { timeoutMs: 15_000 });
  if (iiiResult.code !== 0 && iiiPath !== (platform === "win32" ? "iii.exe" : "iii")) {
    iiiPath = platform === "win32" ? "iii.exe" : "iii";
    iiiResult = await capture(iiiPath, ["--version"], { timeoutMs: 15_000 });
  }
  const iiiVersion = firstVersion(iiiResult.stdout || iiiResult.stderr);
  const iiiCompatible = iiiResult.code === 0 && iiiVersion === EXPECTED_III_ENGINE_VERSION;

  return {
    strategy: dockerReady ? "docker" : iiiCompatible ? "iii" : "deferred",
    docker: { installed: dockerVersionResult.code === 0, ready: dockerReady, version: dockerVersion },
    iii: { installed: iiiResult.code === 0, compatible: iiiCompatible, version: iiiVersion, path: iiiResult.code === 0 ? iiiPath : null }
  };
}

function inspectInstalledVersions(directory, expected) {
  const versions = {};
  for (const name of Object.keys(expected)) {
    const packagePath = path.join(directory, "node_modules", ...name.split("/"), "package.json");
    const manifest = readJsonFile(packagePath, null);
    versions[name] = typeof manifest?.version === "string" ? manifest.version : null;
  }
  return versions;
}

function versionMismatches(expected, actual) {
  return Object.entries(expected)
    .filter(([name, version]) => actual[name] !== version)
    .map(([name, version]) => `${name}: ${actual[name] ?? "missing"} (expected ${version})`);
}

function summarizeVersions(versions) {
  return Object.entries(versions).map(([name, version]) => `${name}@${version}`).join(", ") || "none";
}

function firstVersion(value) {
  const match = String(value || "").match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match?.[1] ?? null;
}

function readJsonFile(file, fallback = {}) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, file);
}

function captureCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 30_000);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, signal: null, stdout, stderr: error.message });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

async function runCommand(command, args, options = {}) {
  const result = await captureCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.code}: ${result.stderr || result.stdout}`);
  }
  return result;
}
