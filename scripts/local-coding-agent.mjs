#!/usr/bin/env node
// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { emitKeypressEvents } from "node:readline";
import { createInterface as createPromptInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProjectCommands } from "./lib/project-commands.mjs";
import {
  detectSetupPlatform,
  normalizeTunnelArch,
  ripgrepInstallCommand,
  tunnelAssetName,
  tunnelAssetUrl,
} from "./lib/setup-platform.mjs";
import { createSetupCommands } from "./lib/setup-commands.mjs";
import { createManagedRuntimeCommands } from "./lib/managed-runtime-commands.mjs";
import { createServiceLifecycle } from "./lib/service-lifecycle.mjs";
import { createConfigCommands } from "./lib/config-commands.mjs";
import { createIntegrationCommands } from "./lib/integration-commands.mjs";
import { openUrl } from "./lib/open-url.mjs";
import { createSkillsTuiCommands } from "./lib/skills-tui-commands.mjs";
import { createLauncherProcessRuntime } from "./lib/launcher-process-runtime.mjs";
import { createImproveCommand } from "./lib/improve-command.mjs";
import { PersistentHttpMcpClient } from "../server/persistent-http-mcp-client.mjs";
export {
  normalizeTunnelArch,
  tunnelAssetName,
  tunnelAssetUrl,
  ripgrepInstallCommand,
};
import {
  MIN_NODE_MAJOR,
  createManagedRuntimePaths,
} from "./managed-runtime.mjs";
import { createAgentMemoryPortabilityPaths } from "./agentmemory-portability.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const SERVER_DIR = join(REPO_ROOT, "server");
const SERVER_SCRIPT = "server.mjs";
const ENV_LOCAL_PATH = join(REPO_ROOT, ".env.local");
const ENV_EXAMPLE_PATH = join(REPO_ROOT, ".env.example");
export const CLI_NAME = "lca-custom";
const CONFIG_PATH = process.env.LCA_CUSTOM_CONFIG_PATH || defaultConfigPath();
const PID_PATH = join(dirname(CONFIG_PATH), "processes.json");
const LOG_PATH = join(dirname(CONFIG_PATH), "launcher.log");
const START_LOCK_PATH = join(dirname(CONFIG_PATH), "start.lock");
const START_LOCK_OWNER_PATH = join(START_LOCK_PATH, "owner.json");
const MANAGED_RUNTIME_PATHS = createManagedRuntimePaths({
  repoRoot: REPO_ROOT,
  configPath: CONFIG_PATH,
});
const AGENTMEMORY_PORTABILITY_PATHS = createAgentMemoryPortabilityPaths({
  configPath: CONFIG_PATH,
  memoryCliPath: MANAGED_RUNTIME_PATHS.memoryCliPath,
});
const LCA_VERSION = "4.4.0-pro";
const DEFAULT_PORT = "8790";
const DEFAULT_FIGMA_DESKTOP_MCP_URL = "http://127.0.0.1:3845/mcp";
const KEY_URLS = [
  "https://platform.openai.com/settings/organization/tunnels",
  "https://platform.openai.com/settings/organization/api-keys",
];

loadRepoEnvIntoProcess();

function defaultConfigPath() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA || join(home, "AppData", "Roaming"),
      "LocalCodingAgentCustom",
      "cli-config.json",
    );
  }
  if (process.platform === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "LocalCodingAgentCustom",
      "cli-config.json",
    );
  }
  return join(
    process.env.XDG_CONFIG_HOME || join(home, ".config"),
    "LocalCodingAgentCustom",
    "cli-config.json",
  );
}

function defaultTunnelBinForPlatform(platform = detectSetupPlatform()) {
  return join(
    REPO_ROOT,
    "tools",
    platform.executable ||
      (platform.tunnelOs === "windows" ? "tunnel-client.exe" : "tunnel-client"),
  );
}

function isDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function defaultOptions() {
  loadRepoEnvIntoProcess();
  return {
    node: process.env.NODE || "node",
    workspace: process.env.AGENT_WORKSPACE || "",
    extraRoots: process.env.AGENT_EXTRA_ROOTS || "",
    extraRootsJson: process.env.AGENT_EXTRA_ROOTS_JSON || "",
    port: process.env.PORT || DEFAULT_PORT,
    authToken: process.env.MCP_AUTH_TOKEN || "",
    tunnelBin:
      process.env.TUNNEL_BIN ||
      defaultTunnelBinForPlatform(detectSetupPlatform()),
    profile: process.env.TUNNEL_PROFILE || "local-coding-agent-custom",
    profileDir:
      process.env.TUNNEL_PROFILE_DIR || join(REPO_ROOT, "tools", "profiles"),
    tunnelId:
      process.env.CONTROL_PLANE_TUNNEL_ID || process.env.TUNNEL_ID || "",
    organizationId:
      process.env.OPENAI_ORGANIZATION || process.env.OPENAI_ORG_ID || "",
    runtimeKeyEnv: "CONTROL_PLANE_API_KEY",
    runtimeKey: "",
    noTunnel: false,
  };
}

function usage() {
  console.log(`Local Coding Agent CLI

Usage:
  lca-custom start [--background] [--no-tunnel]
  lca-custom stop
  lca-custom status
  lca-custom doctor [--json]
  lca-custom improve [--latest|--performance|--tests|--dependencies|--security] [--maintenance] [--apply-safe] [--apply <candidate-id>] [--json]
  lca-custom tui
  lca-custom install [--force] [--json]
  lca-custom memory status [--json]
  lca-custom memory export [file] [--json]
  lca-custom memory import <file> [--dry-run] [--strategy skip|merge|replace] [--force] [--json]
  lca-custom add [path]
  lca-custom remove [path]
  lca-custom primary [path]
  lca-custom reset [path]
  lca-custom profile
  lca-custom url
  lca-custom setup
  lca-custom config
  lca-custom figma [connect|status|tools|open]
  lca-custom update

Options:
  --workspace <path>          Primary project root for discovery and relative paths
  --port <port>               MCP server port
  --auth-token <token>        Optional MCP bearer token
  --node <path>               Node executable
  --background                Keep server/tunnel running after this command exits
  --dry-run                   Validate without changing AgentMemory
  --latest                    Show latest self-improvement candidates first
  --performance               Filter improvement report to performance/agent-strategy candidates
  --tests                     Filter improvement report to test-quality candidates
  --dependencies              Filter improvement report to dependency candidates
  --security                  Filter improvement report to security candidates
  --limit <count>             Maximum improvement candidates to display (default 10)
  --apply <candidate-id>      Explicitly apply one deterministic improvement candidate; never commits or pushes
  --maintenance               Run the full self-improvement sensor sweep and rank maintenance candidates
  --apply-safe                With maintenance, apply at most one explicitly low-risk deterministic candidate
  --strategy <mode>           Import strategy: skip, merge, or replace

Tunnel options:
  --no-tunnel                 Start only the local MCP server
  --tunnel-bin <path>         Path to tunnel-client(.exe)
  --tunnel-id <id>            OpenAI tunnel ID, e.g. tunnel_...
  --organization-id <id>      Optional OpenAI organization ID/header
  --profile <name>            Tunnel profile name
  --profile-dir <path>        Tunnel profile directory
  --runtime-key-env <name>    Env var containing Runtime API key
  --runtime-key <key>         Runtime API key for this process

Project commands default to the current Git root when [path] is omitted.
Use \`lca-custom start --background\` to keep the agent running as a daemon.
`);
}

function setupUsage() {
  console.log(`Local Coding Agent setup wizard

Usage:
  bash scripts/lca-custom setup          # macOS/Linux/WSL
  scripts\\lca-custom.cmd setup          # Windows
  node scripts/local-coding-agent.mjs setup

The wizard uses only Node.js built-ins. It auto-detects the current OS, checks
prerequisites, creates or updates .env.local, installs server dependencies,
installs the pinned server + lean AgentMemory managed runtime, builds the compact interface,
checks the local Figma Desktop MCP bridge, downloads tunnel-client when possible,
writes an isolated staging CLI config, installs the global lca-custom command, and prints health/status checks.

Use --choose-os only when you want instruction mode for another OS.
`);
}

export function parseArgs(argv) {
  if (argv.length === 0) {
    return { command: "help", rest: [], flags: {} };
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { command: "help", rest: [], flags: { help: true } };
  }
  const [command, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = () => {
      if (i + 1 >= rest.length) throw new Error(`Missing value for ${arg}`);
      return rest[++i];
    };
    switch (arg) {
      case "--help":
      case "-h":
        flags.help = true;
        break;
      case "--workspace":
        flags.workspace = next();
        break;
      case "--extra-roots":
        flags.extraRoots = next();
        break;
      case "--port":
        flags.port = next();
        break;
      case "--auth-token":
        flags.authToken = next();
        break;
      case "--node":
        flags.node = next();
        break;
      case "--background":
      case "--daemon":
        flags.background = true;
        break;
      case "--no-tunnel":
        flags.noTunnel = true;
        break;
      case "--tunnel-bin":
        flags.tunnelBin = next();
        break;
      case "--tunnel-id":
        flags.tunnelId = next();
        break;
      case "--organization-id":
        flags.organizationId = next();
        break;
      case "--profile":
        flags.profile = next();
        break;
      case "--profile-dir":
        flags.profileDir = next();
        break;
      case "--runtime-key-env":
        flags.runtimeKeyEnv = next();
        break;
      case "--runtime-key":
        flags.runtimeKey = next();
        break;
      case "--choose-os":
        flags.chooseOs = true;
        break;
      case "--save":
        flags.save = true;
        break;
      case "--force":
        flags.force = true;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--strategy":
        flags.strategy = next();
        break;
      case "--json":
        flags.json = true;
        break;
      case "--latest":
        flags.latest = true;
        break;
      case "--performance":
        flags.performance = true;
        break;
      case "--tests":
        flags.tests = true;
        break;
      case "--dependencies":
        flags.dependencies = true;
        break;
      case "--security":
        flags.security = true;
        break;
      case "--limit":
        flags.limit = Number(next());
        if (!Number.isInteger(flags.limit) || flags.limit < 1 || flags.limit > 100) {
          throw new Error("--limit must be an integer between 1 and 100");
        }
        break;
      case "--apply":
        flags.apply = String(next()).trim();
        if (!flags.apply) throw new Error("--apply requires a candidate id");
        break;
      case "--maintenance":
        flags.maintenance = true;
        break;
      case "--apply-safe":
        flags.applySafe = true;
        flags.maintenance = true;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
        positional.push(arg);
        break;
    }
  }
  return { command, rest: positional, flags };
}

function ensureConfigDir() {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
}

function readJsonFile(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  return { ...defaultOptions(), ...readJsonFile(CONFIG_PATH, {}) };
}

async function saveConfig(cfg) {
  ensureConfigDir();
  await writeFile(
    CONFIG_PATH,
    `${JSON.stringify(stripRuntimeFields(cfg), null, 2)}\n`,
    "utf8",
  );
  try {
    await chmod(CONFIG_PATH, 0o600);
  } catch {
    /* Windows may ignore POSIX mode. */
  }
}

function effectiveOptions(flags = {}) {
  loadRepoEnvIntoProcess();
  const cfg = loadConfig();
  return normalize({ ...defaultOptions(), ...cfg, ...flags });
}

export function normalize(opts) {
  const out = { ...opts };
  out.port = String(out.port || DEFAULT_PORT);
  delete out.mode;
  delete out.policy;
  delete out.surface;
  out.runtimeKeyEnv = out.runtimeKeyEnv || "CONTROL_PLANE_API_KEY";
  out.profile = out.profile || "local-coding-agent";
  out.profileDir = out.profileDir || join(REPO_ROOT, "tools", "profiles");
  out.tunnelBin = out.tunnelBin || defaultOptions().tunnelBin;
  out.node = out.node || "node";
  out.noTunnel = toBool(out.noTunnel);
  let projects = normalizeProjectRoots(out);
  if (out.workspace) {
    const primary = resolve(out.workspace);
    projects = [primary, ...projects.filter((project) => project !== primary)];
  }
  out.projects = projects;
  out.workspace = projects[0] || "";
  out.extraRoots = projects.slice(1).join(";");
  delete out.extraRootsJson;
  return out;
}

export function promoteProjectRoot(projects, project) {
  const target = resolve(project);
  return [
    target,
    ...normalizeProjectRoots({ projects }).filter((item) => item !== target),
  ];
}

export function normalizeProjectRoots(opts = {}) {
  const candidates = [];
  if (Array.isArray(opts.projects) && opts.projects.length) {
    candidates.push(...opts.projects);
  } else {
    if (opts.workspace) candidates.push(opts.workspace);
    const json = String(opts.extraRootsJson || "").trim();
    let parsedJson = false;
    if (json) {
      try {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed)) {
          candidates.push(...parsed);
          parsedJson = true;
        }
      } catch {
        // Fall back to the legacy semicolon-separated value.
      }
    }
    if (!parsedJson)
      candidates.push(...String(opts.extraRoots || "").split(";"));
  }
  const seen = new Set();
  const roots = [];
  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (!text) continue;
    const project = resolve(text);
    const key = process.platform === "win32" ? project.toLowerCase() : project;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(project);
  }
  return roots;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value.replace(/\\n/g, "\n");
  }
  return values;
}

function readRepoEnvFile() {
  if (!existsSync(ENV_LOCAL_PATH)) return {};
  return parseDotEnv(readFileSync(ENV_LOCAL_PATH, "utf8"));
}

function readManagedRepoEnvKeys() {
  if (!existsSync(ENV_EXAMPLE_PATH)) return new Set();
  return new Set(
    Object.keys(parseDotEnv(readFileSync(ENV_EXAMPLE_PATH, "utf8"))),
  );
}

export function applyRepoEnvValues(
  values,
  environment = process.env,
  { override = false, managedKeys = new Set() } = {},
) {
  for (const [key, value] of Object.entries(values || {})) {
    if (override || environment[key] === undefined || managedKeys.has(key))
      environment[key] = value;
  }
  return environment;
}

function loadRepoEnvIntoProcess({ override = false } = {}) {
  const values = readRepoEnvFile();
  applyRepoEnvValues(values, process.env, {
    override,
    managedKeys: readManagedRepoEnvKeys(),
  });
  return values;
}

function envValueNeedsQuotes(value) {
  return /[\s"'#]/.test(String(value));
}

function formatEnvValue(value) {
  const text = String(value ?? "");
  if (!envValueNeedsQuotes(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function mergeDotEnvText(existingText, updates) {
  const keys = new Set(
    Object.keys(updates).filter((key) => updates[key] !== undefined),
  );
  const seen = new Set();
  const lines = String(existingText || "").trim()
    ? String(existingText || "").split(/\r?\n/)
    : [];
  const hadTrailingBlank = lines.length > 1 && lines[lines.length - 1] === "";
  const nextLines = [];
  for (const rawLine of lines) {
    if (!rawLine && rawLine === lines[lines.length - 1] && hadTrailingBlank)
      continue;
    const match = rawLine.match(
      /^(\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/,
    );
    if (!match || !keys.has(match[2])) {
      nextLines.push(rawLine);
      continue;
    }
    seen.add(match[2]);
    nextLines.push(
      `${match[1]}${match[2]}${match[3]}${formatEnvValue(updates[match[2]])}`,
    );
  }
  for (const key of keys) {
    if (!seen.has(key))
      nextLines.push(`${key}=${formatEnvValue(updates[key])}`);
  }
  return `${nextLines.filter((line, index) => line || index < nextLines.length - 1).join("\n")}\n`;
}

async function writeRepoEnv(updates) {
  const existing = existsSync(ENV_LOCAL_PATH)
    ? readFileSync(ENV_LOCAL_PATH, "utf8")
    : existsSync(ENV_EXAMPLE_PATH)
      ? readFileSync(ENV_EXAMPLE_PATH, "utf8")
      : "";
  await writeFile(ENV_LOCAL_PATH, mergeDotEnvText(existing, updates), "utf8");
  try {
    await chmod(ENV_LOCAL_PATH, 0o600);
  } catch {
    /* Windows may ignore POSIX mode. */
  }
  loadRepoEnvIntoProcess({ override: true });
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function validate(
  opts,
  { requireWorkspace = false, requireTunnel = false } = {},
) {
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("port must be a TCP port.");
  if (requireWorkspace) {
    if (!opts.projects?.length)
      throw new Error(
        "No projects configured. Run `lca-custom add [path]` or `lca-custom reset [path]` first.",
      );
    for (const project of opts.projects) {
      if (!isDirectory(project))
        throw new Error(`Project directory does not exist: ${project}`);
    }
  }
  if (requireTunnel && !opts.noTunnel) {
    if (!opts.tunnelId)
      throw new Error("Missing tunnel ID. Run `setup` or pass --tunnel-id.");
    if (!existsSync(opts.tunnelBin))
      throw new Error(`Tunnel client not found: ${opts.tunnelBin}`);
  }
}

function yamlEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function hashDirectoryTree(directory) {
  if (!existsSync(directory)) return "missing";
  const hash = createHash("sha256");
  const visit = (current, relative) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        hash.update(`dir:${childRelative}\0`);
        visit(absolute, childRelative);
      } else if (entry.isFile()) {
        hash.update(`file:${childRelative}\0`);
        hash.update(readFileSync(absolute));
        hash.update("\0");
      }
    }
  };
  visit(directory, "");
  return hash.digest("hex").slice(0, 16);
}

function figmaDesktopEndpoint() {
  return String(
    process.env.FIGMA_DESKTOP_MCP_URL || DEFAULT_FIGMA_DESKTOP_MCP_URL,
  ).trim();
}

function configId(opts) {
  const serverPath = join(SERVER_DIR, SERVER_SCRIPT);
  const figmaBridgePath = join(SERVER_DIR, "figma-desktop.mjs");
  const dbeaverBridgePath = join(SERVER_DIR, "dbeaver-desktop.mjs");
  const brunoBridgePath = join(SERVER_DIR, "bruno-desktop.mjs");
  const penpotBridgePath = join(SERVER_DIR, "penpot-desktop.mjs");
  const coolifyBridgePath = join(SERVER_DIR, "coolify-mcp.mjs");
  const persistentHttpBridgePath = join(
    SERVER_DIR,
    "persistent-http-mcp-client.mjs",
  );
  const nextRuntimePath = join(SERVER_DIR, "dist");
  const material = JSON.stringify({
    projects: opts.projects || [],
    runtime: "trusted-local-compact",
    extraRoots: opts.extraRoots || "",
    authEnabled: Boolean(opts.authToken),
    port: String(opts.port),
    serverHash: existsSync(serverPath)
      ? sha256(readFileSync(serverPath)).slice(0, 16)
      : "missing",
    nextRuntimeHash: hashDirectoryTree(nextRuntimePath),
    figmaBridgeHash: existsSync(figmaBridgePath)
      ? sha256(readFileSync(figmaBridgePath)).slice(0, 16)
      : "missing",
    dbeaverBridgeHash: existsSync(dbeaverBridgePath)
      ? sha256(readFileSync(dbeaverBridgePath)).slice(0, 16)
      : "missing",
    brunoBridgeHash: existsSync(brunoBridgePath)
      ? sha256(readFileSync(brunoBridgePath)).slice(0, 16)
      : "missing",
    coolifyBridgeHash: existsSync(coolifyBridgePath)
      ? sha256(readFileSync(coolifyBridgePath)).slice(0, 16)
      : "missing",
    persistentHttpBridgeHash: existsSync(persistentHttpBridgePath)
      ? sha256(readFileSync(persistentHttpBridgePath)).slice(0, 16)
      : "missing",
    figmaDesktopMcpUrl: figmaDesktopEndpoint(),
    figmaDesktopTimeoutMs: process.env.FIGMA_DESKTOP_TIMEOUT_MS || "30000",
    figmaDesktopAllowRemote: process.env.FIGMA_DESKTOP_ALLOW_REMOTE === "1",
    coolifyMcpUrl: process.env.COOLIFY_MCP_URL || "http://36.50.55.5:8000/mcp",
    coolifyMcpAuthHash: process.env.COOLIFY_MCP_AUTH_TOKEN
      ? sha256(Buffer.from(process.env.COOLIFY_MCP_AUTH_TOKEN)).slice(0, 16)
      : "none",
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function stripRuntimeFields(cfg) {
  const out = { ...cfg };
  delete out.command;
  delete out.rest;
  delete out.flags;
  delete out.help;
  delete out.save;
  delete out.background;
  delete out.json;
  delete out.force;
  delete out.mode;
  delete out.policy;
  delete out.surface;
  return out;
}

export function nextRuntimeBuildSpec(platform = process.platform) {
  return {
    command: platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "build:next"],
    cwd: SERVER_DIR,
  };
}

async function runChecked(label, command, args, options = {}) {
  const child = spawnLogged(label, command, args, options);
  const code = await new Promise((resolveExit) =>
    child.on("exit", resolveExit),
  );
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}`);
  return code;
}

async function capture(command, args, options = {}) {
  return new Promise((resolveCapture) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) =>
      resolveCapture({
        code: 127,
        signal: null,
        stdout,
        stderr: error.message,
      }),
    );
    child.on("exit", (code, signal) =>
      resolveCapture({ code, signal, stdout, stderr }),
    );
  });
}

const {
  acquireStartLock,
  appendLog,
  chooseManagedTunnelKeeper,
  findManagedTunnelProcesses,
  isManagedTunnelArgv,
  isPidAlive,
  killPid,
  readJson,
  readPidState,
  spawnLogged,
  stopManagedTunnel,
  tunnelHealthArgs,
  waitForHealth,
  writePidState,
  writeTunnelProfile,
} = createLauncherProcessRuntime({
  LOG_PATH,
  PID_PATH,
  START_LOCK_OWNER_PATH,
  START_LOCK_PATH,
  capture,
  ensureConfigDir,
  readJsonFile,
  yamlEscape,
});
export { chooseManagedTunnelKeeper, isManagedTunnelArgv };

const managedRuntimeCommands = createManagedRuntimeCommands({
  MANAGED_RUNTIME_PATHS,
  capture,
  isPidAlive,
  killPid,
  readJson,
  readPidState,
  runChecked,
});
const {
  ensureManagedRuntime,
  installManagedRuntimeCommand,
  managedRuntimeFastReport,
  printManagedRuntimeReceipt,
  stopManagedServerForRepair,
  withMutedConsoleLog,
  inspectRuntime,
  installPlan,
} = managedRuntimeCommands;

const serviceLifecycle = createServiceLifecycle({
  CONFIG_PATH,
  LOG_PATH,
  PID_PATH,
  SERVER_DIR,
  SERVER_SCRIPT,
  acquireStartLock,
  capture,
  chooseManagedTunnelKeeper,
  configId,
  effectiveOptions,
  ensureManagedRuntime,
  findManagedTunnelProcesses,
  inspectRuntime,
  installManagedRuntimeCommand,
  installPlan,
  isDirectory,
  isPidAlive,
  killPid,
  printManagedRuntimeReceipt,
  readJson,
  readPidState,
  saveConfig,
  spawnLogged,
  stopManagedServerForRepair,
  stopManagedTunnel,
  stripRuntimeFields,
  tunnelHealthArgs,
  validate,
  waitForHealth,
  withMutedConsoleLog,
  writePidState,
  writeTunnelProfile,
});
const {
  installCommand,
  start,
  stop,
  runningStatusForConfig,
  restartIfRunning,
  status,
  doctor,
} = serviceLifecycle;

const { ensureFigmaDesktopConnected, figmaCommand, memoryCommand } =
  createIntegrationCommands({
    AGENTMEMORY_PORTABILITY_PATHS,
    DEFAULT_FIGMA_DESKTOP_MCP_URL,
    LCA_VERSION,
    SERVER_DIR,
    effectiveOptions,
    ensureManagedRuntime,
    restartIfRunning,
  });

const { setup, installCliCommand, cliWrapperContents } = createSetupCommands({
  CLI_NAME,
  CONFIG_PATH,
  DEFAULT_PORT,
  ENV_EXAMPLE_PATH,
  ENV_LOCAL_PATH,
  KEY_URLS,
  MIN_NODE_MAJOR,
  REPO_ROOT,
  SCRIPT_DIR,
  capture,
  defaultTunnelBinForPlatform,
  effectiveOptions,
  ensureFigmaDesktopConnected,
  installManagedRuntimeCommand,
  isDirectory,
  readRepoEnvFile,
  runChecked,
  saveConfig,
  sha256,
  setupUsage,
  stripRuntimeFields,
  validate,
  writeRepoEnv,
});
export { cliWrapperContents };

async function updateSelf(flags) {
  const git = process.platform === "win32" ? "git.exe" : "git";
  const currentConfig = effectiveOptions(flags);
  const runningBefore = await runningStatusForConfig(currentConfig);
  const before = await capture(git, ["status", "--short", "--branch"], {
    cwd: REPO_ROOT,
  });
  if (before.code !== 0)
    throw new Error(`git status failed: ${before.stderr || before.stdout}`);
  console.log(before.stdout.trim() || "working tree clean");
  const dirtyLines = before.stdout
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("##"));
  if (dirtyLines.length && !flags.force) {
    throw new Error(
      "Local changes detected. Review them first, then rerun with --force only if you want to proceed.",
    );
  }
  if (runningBefore.running) await stop(currentConfig);
  await runChecked("git", git, ["fetch", "origin", "main", "--tags"], {
    cwd: REPO_ROOT,
  });
  const incoming = await capture(
    git,
    ["log", "--oneline", "--decorate", "--max-count=10", "HEAD..origin/main"],
    { cwd: REPO_ROOT },
  );
  if (incoming.stdout.trim()) {
    console.log("\nIncoming changes:");
    console.log(incoming.stdout.trim());
  } else {
    console.log("\nAlready up to date with origin/main.");
  }
  await runChecked("git", git, ["pull", "--ff-only", "origin", "main"], {
    cwd: REPO_ROOT,
  });
  await installManagedRuntimeCommand({ ...flags, force: true, json: false });
  await runChecked(
    "check",
    process.execPath,
    ["--check", join(SCRIPT_DIR, "local-coding-agent.mjs")],
    { cwd: REPO_ROOT },
  );
  await runChecked(
    "check",
    process.execPath,
    ["--check", join(SCRIPT_DIR, "network-doctor.mjs")],
    { cwd: REPO_ROOT },
  );
  await runChecked(
    "skills",
    process.execPath,
    [join(SCRIPT_DIR, "validate-skills.mjs")],
    { cwd: REPO_ROOT },
  );
  if (runningBefore.running)
    await start({
      ...currentConfig,
      background: true,
      skipManagedRuntime: true,
    });
  await doctor(flags);
  console.log("\nUpdate complete.");
}

const { configCommand, keyCommand } = createConfigCommands({
  CONFIG_PATH,
  DEFAULT_PORT,
  loadConfig,
  normalize,
  restartIfRunning,
  saveConfig,
  stripRuntimeFields,
  validate,
});

const {
  detectWorkspaceRoot,
  runCurrentWorkspace,
  addProjectCommand,
  removeProjectCommand,
  primaryProjectCommand,
  resetProjectsCommand,
  workspaceCommand,
} = createProjectCommands({
  effectiveOptions,
  normalize,
  normalizeProjectRoots,
  promoteProjectRoot,
  saveConfig,
  stripRuntimeFields,
  start,
  stop,
  restartIfRunning,
  runningStatusForConfig,
  capture,
  REPO_ROOT,
});

async function keysCommand() {
  for (const url of KEY_URLS) {
    if (!openUrl(url)) console.log(url);
  }
}

async function cliCommand() {
  await installCliCommand();
}

const { improveCommand } = createImproveCommand({
  repoRoot: REPO_ROOT,
  detectWorkspaceRoot,
  output,
  createExecutionClient(flags = {}) {
    const opts = effectiveOptions(flags);
    const headers = opts.authToken
      ? { authorization: `Bearer ${opts.authToken}` }
      : undefined;
    return new PersistentHttpMcpClient({
      endpoint: `http://127.0.0.1:${opts.port}/mcp`,
      clientName: "lca-custom-improve",
      clientVersion: LCA_VERSION,
      timeoutMs: 60_000,
      ...(headers ? { requestInit: { headers } } : {})
    });
  }
});

const { skillsCommand, tuiCommand } = createSkillsTuiCommands({
  CLI_SCRIPT_PATH: fileURLToPath(import.meta.url),
  CONFIG_PATH,
  LCA_VERSION,
  LOG_PATH,
  REPO_ROOT,
  SERVER_DIR,
  SCRIPT_DIR,
  effectiveOptions,
  ensureManagedRuntime,
  readJson,
  runChecked,
  runningStatusForConfig,
  start,
  validate,
});

async function main() {
  const { command, rest, flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    if (command === "setup" || command === "init") return setupUsage();
    return usage();
  }
  if (command === "help") return usage();
  if (command === "run" || command === "here")
    return runCurrentWorkspace(flags);
  if (command === "setup" || command === "init") return setup(flags);
  if (command === "install") return installCommand(flags);
  if (command === "cli") return cliCommand();
  if (command === "keys") return keysCommand();
  if (command === "add") return addProjectCommand(rest, flags);
  if (command === "remove") return removeProjectCommand(rest, flags);
  if (command === "primary") return primaryProjectCommand(rest, flags);
  if (command === "reset") return resetProjectsCommand(rest, flags);
  if (command === "workspace") return workspaceCommand(flags);
  if (command === "memory") return memoryCommand(rest, flags);
  if (command === "figma") return figmaCommand(rest, flags);
  if (command === "start") return start(flags);
  if (command === "stop") return stop(flags);
  if (command === "status") return status(flags);
  if (command === "doctor") return doctor(flags);
  if (command === "improve") return improveCommand(rest, flags);
  if (command === "tui") return tuiCommand(flags);
  if (command === "profile") {
    const opts = effectiveOptions(flags);
    validate(opts);
    console.log(writeTunnelProfile(opts));
    return;
  }
  if (command === "url") {
    const opts = effectiveOptions(flags);
    console.log(`http://127.0.0.1:${opts.port}/mcp`);
    return;
  }
  if (command === "logs") {
    console.log(LOG_PATH);
    if (existsSync(LOG_PATH)) console.log(await readFile(LOG_PATH, "utf8"));
    return;
  }
  if (command === "config") return configCommand(rest);
  if (command === "key") return keyCommand(rest);
  if (command === "update") return updateSelf(flags);
  if (command === "skills") return skillsCommand(rest);
  throw new Error(`Unknown command: ${command}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`ERROR: ${error?.message || error}`);
    process.exit(1);
  });
}
