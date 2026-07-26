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
  writeFileSync
} from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { emitKeypressEvents } from "node:readline";
import { createInterface as createPromptInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MIN_NODE_MAJOR,
  createManagedRuntimePaths,
  inspectManagedRuntime,
  installManagedRuntime,
  runtimeInstallPlan
} from "./managed-runtime.mjs";
import {
  ManagedAgentMemoryService,
  agentMemoryPortabilityStatus,
  createAgentMemoryPortabilityPaths,
  exportAgentMemoryBackup,
  importAgentMemoryBackup
} from "./agentmemory-portability.mjs";

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
  configPath: CONFIG_PATH
});
const AGENTMEMORY_PORTABILITY_PATHS = createAgentMemoryPortabilityPaths({
  configPath: CONFIG_PATH,
  memoryCliPath: MANAGED_RUNTIME_PATHS.memoryCliPath
});
const LCA_VERSION = "4.4.0-pro";
const DEFAULT_PORT = "8790";
const DEFAULT_TUNNEL_VERSION = process.env.TUNNEL_CLIENT_VERSION || "v0.0.10";
const DEFAULT_FIGMA_DESKTOP_MCP_URL = "http://127.0.0.1:3845/mcp";
const TUNNEL_RELEASE_BASE = "https://github.com/openai/tunnel-client/releases/download";
const KEY_URLS = [
  "https://platform.openai.com/settings/organization/tunnels",
  "https://platform.openai.com/settings/organization/api-keys"
];

loadRepoEnvIntoProcess();

function defaultConfigPath() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "LocalCodingAgentCustom", "cli-config.json");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "LocalCodingAgentCustom", "cli-config.json");
  }
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "LocalCodingAgentCustom", "cli-config.json");
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
    profileDir: process.env.TUNNEL_PROFILE_DIR || join(REPO_ROOT, "tools", "profiles"),
    tunnelId: process.env.CONTROL_PLANE_TUNNEL_ID || process.env.TUNNEL_ID || "",
    organizationId: process.env.OPENAI_ORGANIZATION || process.env.OPENAI_ORG_ID || "",
    runtimeKeyEnv: "CONTROL_PLANE_API_KEY",
    runtimeKey: "",
    noTunnel: false
  };
}

function usage() {
  console.log(`Local Coding Agent CLI

Usage:
  lca-custom start [--background] [--no-tunnel]
  lca-custom stop
  lca-custom status
  lca-custom doctor [--json]
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
  await writeFile(CONFIG_PATH, `${JSON.stringify(stripRuntimeFields(cfg), null, 2)}\n`, "utf8");
  try { await chmod(CONFIG_PATH, 0o600); } catch { /* Windows may ignore POSIX mode. */ }
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
  return [target, ...normalizeProjectRoots({ projects }).filter((item) => item !== target)];
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
    if (!parsedJson) candidates.push(...String(opts.extraRoots || "").split(";"));
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
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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

function loadRepoEnvIntoProcess({ override = false } = {}) {
  const values = readRepoEnvFile();
  for (const [key, value] of Object.entries(values)) {
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
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
  const keys = new Set(Object.keys(updates).filter((key) => updates[key] !== undefined));
  const seen = new Set();
  const lines = String(existingText || "").trim() ? String(existingText || "").split(/\r?\n/) : [];
  const hadTrailingBlank = lines.length > 1 && lines[lines.length - 1] === "";
  const nextLines = [];
  for (const rawLine of lines) {
    if (!rawLine && rawLine === lines[lines.length - 1] && hadTrailingBlank) continue;
    const match = rawLine.match(/^(\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match || !keys.has(match[2])) {
      nextLines.push(rawLine);
      continue;
    }
    seen.add(match[2]);
    nextLines.push(`${match[1]}${match[2]}${match[3]}${formatEnvValue(updates[match[2]])}`);
  }
  for (const key of keys) {
    if (!seen.has(key)) nextLines.push(`${key}=${formatEnvValue(updates[key])}`);
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
  try { await chmod(ENV_LOCAL_PATH, 0o600); } catch { /* Windows may ignore POSIX mode. */ }
  loadRepoEnvIntoProcess({ override: true });
}

function isPlaceholder(value) {
  const text = String(value || "").trim();
  return !text || text.endsWith("...") || text.includes("<") || text.includes("your-");
}

function isWsl() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

export function normalizeTunnelArch(arch = os.arch()) {
  const value = String(arch).toLowerCase();
  if (["x64", "amd64"].includes(value)) return "amd64";
  if (["arm64", "aarch64"].includes(value)) return "arm64";
  throw new Error(`Unsupported CPU architecture for tunnel-client: ${arch}`);
}

export function detectSetupPlatform() {
  const raw = process.platform;
  if (isWsl()) return { id: "wsl", label: "WSL", tunnelOs: "linux", arch: normalizeTunnelArch(), executable: "tunnel-client" };
  if (raw === "darwin") return { id: "darwin", label: "macOS", tunnelOs: "darwin", arch: normalizeTunnelArch(), executable: "tunnel-client" };
  if (raw === "linux") return { id: "linux", label: "Linux", tunnelOs: "linux", arch: normalizeTunnelArch(), executable: "tunnel-client" };
  if (raw === "win32") return { id: "win32", label: "Windows", tunnelOs: "windows", arch: normalizeTunnelArch(), executable: "tunnel-client.exe" };
  return { id: raw, label: raw, tunnelOs: raw, arch: normalizeTunnelArch(), executable: raw === "win32" ? "tunnel-client.exe" : "tunnel-client" };
}

function setupPlatformChoices() {
  const arch = normalizeTunnelArch();
  return [
    { id: "darwin", label: "macOS", tunnelOs: "darwin", arch, executable: "tunnel-client" },
    { id: "linux", label: "Linux", tunnelOs: "linux", arch, executable: "tunnel-client" },
    { id: "win32", label: "Windows", tunnelOs: "windows", arch, executable: "tunnel-client.exe" },
    { id: "wsl", label: "WSL", tunnelOs: "linux", arch, executable: "tunnel-client" }
  ];
}

function platformMatchesHost(selected, host = detectSetupPlatform()) {
  return selected.id === host.id;
}

function defaultTunnelBinForPlatform(platform = detectSetupPlatform()) {
  return join(REPO_ROOT, "tools", platform.executable || (platform.tunnelOs === "windows" ? "tunnel-client.exe" : "tunnel-client"));
}

export function tunnelAssetName(version = DEFAULT_TUNNEL_VERSION, tunnelOs = detectSetupPlatform().tunnelOs, arch = normalizeTunnelArch()) {
  return `tunnel-client-${version}-${tunnelOs}-${normalizeTunnelArch(arch)}.zip`;
}

export function tunnelAssetUrl(version = DEFAULT_TUNNEL_VERSION, tunnelOs = detectSetupPlatform().tunnelOs, arch = normalizeTunnelArch()) {
  return `${TUNNEL_RELEASE_BASE}/${version}/${tunnelAssetName(version, tunnelOs, arch)}`;
}

export function ripgrepInstallCommand(platform = detectSetupPlatform(), availableCommands = []) {
  const has = (name) => availableCommands.includes(name);
  if (platform.id === "darwin") {
    return has("brew") ? { label: "Homebrew", command: "brew", args: ["install", "ripgrep"] } : null;
  }
  if (platform.id === "win32") {
    return has("winget") ? { label: "winget", command: "winget", args: ["install", "--id", "BurntSushi.ripgrep.MSVC", "-e"] } : null;
  }
  if (platform.id === "linux" || platform.id === "wsl") {
    const sudo = typeof process.getuid === "function" && process.getuid() === 0 ? [] : has("sudo") ? ["sudo"] : [];
    if (has("apt-get")) return { label: "apt-get", command: sudo[0] || "apt-get", args: [...sudo.slice(1), ...(sudo[0] ? ["apt-get"] : []), "install", "-y", "ripgrep"] };
    if (has("dnf")) return { label: "dnf", command: sudo[0] || "dnf", args: [...sudo.slice(1), ...(sudo[0] ? ["dnf"] : []), "install", "-y", "ripgrep"] };
    if (has("yum")) return { label: "yum", command: sudo[0] || "yum", args: [...sudo.slice(1), ...(sudo[0] ? ["yum"] : []), "install", "-y", "ripgrep"] };
    if (has("pacman")) return { label: "pacman", command: sudo[0] || "pacman", args: [...sudo.slice(1), ...(sudo[0] ? ["pacman"] : []), "-S", "--noconfirm", "ripgrep"] };
    if (has("zypper")) return { label: "zypper", command: sudo[0] || "zypper", args: [...sudo.slice(1), ...(sudo[0] ? ["zypper"] : []), "--non-interactive", "install", "ripgrep"] };
  }
  return null;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function validate(opts, { requireWorkspace = false, requireTunnel = false } = {}) {
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be a TCP port.");
  if (requireWorkspace) {
    if (!opts.projects?.length) throw new Error("No projects configured. Run `lca-custom add [path]` or `lca-custom reset [path]` first.");
    for (const project of opts.projects) {
      if (!isDirectory(project)) throw new Error(`Project directory does not exist: ${project}`);
    }
  }
  if (requireTunnel && !opts.noTunnel) {
    if (!opts.tunnelId) throw new Error("Missing tunnel ID. Run `setup` or pass --tunnel-id.");
    if (!existsSync(opts.tunnelBin)) throw new Error(`Tunnel client not found: ${opts.tunnelBin}`);
  }
}

function yamlEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function hashDirectoryTree(directory) {
  if (!existsSync(directory)) return "missing";
  const hash = createHash("sha256");
  const visit = (current, relative) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
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

function configId(opts) {
  const serverPath = join(SERVER_DIR, SERVER_SCRIPT);
  const figmaBridgePath = join(SERVER_DIR, "figma-desktop.mjs");
  const dbeaverBridgePath = join(SERVER_DIR, "dbeaver-desktop.mjs");
  const brunoBridgePath = join(SERVER_DIR, "bruno-desktop.mjs");
  const coolifyBridgePath = join(SERVER_DIR, "coolify-mcp.mjs");
  const persistentHttpBridgePath = join(SERVER_DIR, "persistent-http-mcp-client.mjs");
  const nextRuntimePath = join(SERVER_DIR, "dist");
  const material = JSON.stringify({
    projects: opts.projects || [],
    runtime: "trusted-local-compact",
    extraRoots: opts.extraRoots || "",
    authEnabled: Boolean(opts.authToken),
    port: String(opts.port),
    serverHash: existsSync(serverPath) ? sha256(readFileSync(serverPath)).slice(0, 16) : "missing",
    nextRuntimeHash: hashDirectoryTree(nextRuntimePath),
    figmaBridgeHash: existsSync(figmaBridgePath) ? sha256(readFileSync(figmaBridgePath)).slice(0, 16) : "missing",
    dbeaverBridgeHash: existsSync(dbeaverBridgePath) ? sha256(readFileSync(dbeaverBridgePath)).slice(0, 16) : "missing",
    brunoBridgeHash: existsSync(brunoBridgePath) ? sha256(readFileSync(brunoBridgePath)).slice(0, 16) : "missing",
    coolifyBridgeHash: existsSync(coolifyBridgePath) ? sha256(readFileSync(coolifyBridgePath)).slice(0, 16) : "missing",
    persistentHttpBridgeHash: existsSync(persistentHttpBridgePath) ? sha256(readFileSync(persistentHttpBridgePath)).slice(0, 16) : "missing",
    figmaDesktopMcpUrl: figmaDesktopEndpoint(),
    figmaDesktopTimeoutMs: process.env.FIGMA_DESKTOP_TIMEOUT_MS || "30000",
    figmaDesktopAllowRemote: process.env.FIGMA_DESKTOP_ALLOW_REMOTE === "1",
    coolifyMcpUrl: process.env.COOLIFY_MCP_URL || "http://36.50.55.5:8000/mcp",
    coolifyMcpAuthHash: process.env.COOLIFY_MCP_AUTH_TOKEN
      ? sha256(Buffer.from(process.env.COOLIFY_MCP_AUTH_TOKEN)).slice(0, 16)
      : "none"
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function tunnelHealthArgs() {
  if (process.platform === "win32") {
    return ["--health.listen-addr", "127.0.0.1:0"];
  }
  const socketPath = `/tmp/lca-tunnel-${process.pid}.sock`;
  rmSync(socketPath, { force: true });
  return ["--health.unix-socket", socketPath];
}

async function readJson(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function appendLog(line) {
  ensureConfigDir();
  const stamp = new Date().toISOString();
  writeFileSync(LOG_PATH, `[${stamp}] ${line}\n`, { encoding: "utf8", flag: "a" });
}

function spawnLogged(label, command, args, options = {}) {
  const printable = `${command} ${args.join(" ")}`;
  console.log(`[${label}] ${printable}`);
  appendLog(`[${label}] ${printable}`);
  const child = spawn(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    stdio: options.stdio || "inherit",
    detached: Boolean(options.detached),
    shell: false,
    windowsHide: true
  });
  child.on("exit", (code, signal) => {
    appendLog(`[${label}] exited code=${code} signal=${signal || ""}`);
    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
      console.error(`[${label}] exited code=${code} signal=${signal || ""}`);
    }
  });
  return child;
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function samePath(left, right) {
  if (!left || !right) return false;
  try {
    return realpathSync(String(left)) === realpathSync(String(right));
  } catch {
    return resolve(String(left)) === resolve(String(right));
  }
}

function argvOptionValue(argv, option) {
  const index = argv.lastIndexOf(option);
  return index >= 0 && index + 1 < argv.length ? String(argv[index + 1]) : "";
}

export function isManagedTunnelArgv(argv, opts = {}) {
  if (!Array.isArray(argv) || argv.length < 2 || !samePath(argv[0], opts.tunnelBin)) return false;
  if (argv[1] !== "run") return false;
  if (argvOptionValue(argv, "--profile") !== String(opts.profile || "")) return false;
  if (!samePath(argvOptionValue(argv, "--profile-dir"), opts.profileDir)) return false;
  const expectedTunnelId = String(opts.tunnelId || "");
  return !expectedTunnelId || argvOptionValue(argv, "--control-plane.tunnel-id") === expectedTunnelId;
}

export function chooseManagedTunnelKeeper(processes, state = {}, current = {}) {
  if (String(state.configId || "") !== String(current.configId || "")) return null;
  if (String(state.port || "") !== String(current.port || "")) return null;
  const rememberedPid = Number(state.tunnelPid || 0);
  return processes.find((entry) => Number(entry.pid) === rememberedPid) || null;
}

function splitCommandLine(commandLine) {
  const tokens = [];
  let token = "";
  let quote = "";
  let escaped = false;
  for (const char of String(commandLine || "")) {
    if (escaped) {
      token += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += char;
    }
  }
  if (escaped) token += "\\";
  if (token) tokens.push(token);
  return tokens;
}

async function findManagedTunnelProcesses(opts) {
  const matches = [];
  if (process.platform === "linux" && existsSync("/proc")) {
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      if (!pid || pid === process.pid) continue;
      try {
        const argv = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
        if (isManagedTunnelArgv(argv, opts)) matches.push({ pid, argv });
      } catch {
        // The process may exit while /proc is being inspected.
      }
    }
  } else if (process.platform === "win32") {
    const command = "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const result = await capture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
    if (result.code === 0 && result.stdout.trim()) {
      try {
        const parsed = JSON.parse(result.stdout);
        for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
          const argv = splitCommandLine(item?.CommandLine || "");
          if (isManagedTunnelArgv(argv, opts)) matches.push({ pid: Number(item.ProcessId), argv });
        }
      } catch {
        // Fall back to the remembered PID when process enumeration is unavailable.
      }
    }
  } else {
    const result = await capture("ps", ["-eo", "pid=,command="]);
    if (result.code === 0) {
      for (const line of result.stdout.split(/\r?\n/)) {
        const match = line.match(/^\s*(\d+)\s+(.+)$/);
        if (!match) continue;
        const argv = splitCommandLine(match[2]);
        if (isManagedTunnelArgv(argv, opts)) matches.push({ pid: Number(match[1]), argv });
      }
    }
  }
  return matches.sort((left, right) => left.pid - right.pid);
}

async function stopManagedTunnel(entry, opts, timeoutMs = 2000) {
  if (!entry?.pid || !isPidAlive(entry.pid)) return true;
  killPid(entry.pid);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(entry.pid)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (isPidAlive(entry.pid) && process.platform !== "win32") {
    const stillManaged = (await findManagedTunnelProcesses(opts)).some((candidate) => candidate.pid === entry.pid);
    if (stillManaged) {
      try { process.kill(entry.pid, "SIGKILL"); } catch {}
    }
  }
  return !isPidAlive(entry.pid);
}

async function acquireStartLock(timeoutMs = 15000) {
  ensureConfigDir();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      mkdirSync(START_LOCK_PATH);
      writeFileSync(START_LOCK_OWNER_PATH, `${JSON.stringify({ pid: process.pid, createdAtMs: Date.now() })}\n`, "utf8");
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmSync(START_LOCK_PATH, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = {};
      let lockAgeMs = Infinity;
      try { owner = JSON.parse(readFileSync(START_LOCK_OWNER_PATH, "utf8")); } catch {}
      try { lockAgeMs = Date.now() - statSync(START_LOCK_PATH).mtimeMs; } catch {}
      if (!isPidAlive(owner.pid) || lockAgeMs > 5 * 60_000) {
        rmSync(START_LOCK_PATH, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Another lca-custom start/stop operation is still running in PID ${owner.pid || "unknown"}.`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
}

function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(Number(pid), "SIGTERM");
    }
  } catch {
    // Best-effort only.
  }
}

function readPidState() {
  return readJsonFile(PID_PATH, {});
}

async function writePidState(state) {
  ensureConfigDir();
  await writeFile(PID_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function waitForHealth(port, attempts = 40) {
  const url = `http://127.0.0.1:${port}/healthz`;
  for (let i = 0; i < attempts; i++) {
    const health = await readJson(url);
    if (health?.status === "ok") return health;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

function writeTunnelProfile(opts) {
  if (!opts.tunnelId) throw new Error("Missing tunnel ID. Run `setup` or pass --tunnel-id.");
  mkdirSync(opts.profileDir, { recursive: true });
  const fileName = opts.profile.endsWith(".yaml") ? opts.profile : `${opts.profile}.yaml`;
  const profilePath = join(opts.profileDir, fileName);
  const lines = [
    "config_version: 1",
    "control_plane:",
    '  base_url: "https://api.openai.com"',
    `  tunnel_id: "${yamlEscape(opts.tunnelId.trim())}"`,
    '  api_key: "env:CONTROL_PLANE_API_KEY"'
  ];
  if (opts.organizationId) {
    lines.push("  extra_headers:");
    lines.push(`    - "OpenAI-Organization: ${yamlEscape(opts.organizationId.trim())}"`);
  }
  lines.push(
    "log:",
    "  level: info",
    "  format: json",
    "mcp:",
    "  server_urls:",
    "    - channel: main",
    `      url: "http://127.0.0.1:${opts.port}/mcp"`
  );
  writeFileSync(profilePath, `${lines.join("\n")}\n`, "utf8");
  return profilePath;
}

async function promptLine(rl, label, current = "") {
  const suffix = current ? ` [${current}]` : "";
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || current;
}

async function promptYesNo(rl, label, current = false) {
  const suffix = current ? "Y/n" : "y/N";
  const answer = (await rl.question(`${label} (${suffix}): `)).trim().toLowerCase();
  if (!answer) return Boolean(current);
  return ["y", "yes", "1", "true"].includes(answer);
}

async function promptSecretUpdate(rl, label, current = "") {
  const suffix = current ? " [saved, leave blank to keep]" : " [optional]";
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || current;
}

async function promptSecretRequired(rl, label, current = "") {
  const suffix = current ? " [saved, leave blank to keep]" : "";
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || current;
}

async function promptChoice(rl, label, choices, currentId = "") {
  const defaultIndex = Math.max(0, choices.findIndex((choice) => choice.id === currentId));
  console.log(label);
  choices.forEach((choice, index) => {
    const marker = index === defaultIndex ? " default" : "";
    console.log(`  ${index + 1}. ${choice.label}${marker}`);
  });
  while (true) {
    const answer = (await rl.question(`Choose [${defaultIndex + 1}]: `)).trim();
    if (!answer) return choices[defaultIndex];
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && choices[index]) return choices[index];
    const byId = choices.find((choice) => choice.id.toLowerCase() === answer.toLowerCase());
    if (byId) return byId;
    console.log("Please enter one of the listed numbers.");
  }
}

function printStep(index, total, title) {
  console.log(`\n[${index}/${total}] ${title}`);
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function commandAvailable(command) {
  const res = await capture(command, ["--version"]);
  return res.code === 0;
}

async function detectAvailableCommands(commands) {
  const found = [];
  for (const command of commands) {
    if (await commandAvailable(command)) found.push(command);
  }
  return found;
}

function ripgrepManualInstallHint(platform = detectSetupPlatform()) {
  if (platform.id === "darwin") return "Install manually: brew install ripgrep";
  if (platform.id === "win32") return "Install manually: winget install BurntSushi.ripgrep.MSVC";
  if (platform.id === "linux" || platform.id === "wsl") return "Install manually with your package manager, e.g. sudo apt-get install -y ripgrep";
  return "Install ripgrep from https://github.com/BurntSushi/ripgrep";
}

async function ensureRipgrep(platform = detectSetupPlatform()) {
  const existing = await capture(process.platform === "win32" ? "rg.exe" : "rg", ["--version"]);
  if (existing.code === 0) {
    console.log(`OK ${existing.stdout.split(/\r?\n/)[0]}`);
    return true;
  }
  console.log("WARN ripgrep not found; attempting install because it makes repo search much faster.");
  const candidates = platform.id === "darwin"
    ? ["brew"]
    : platform.id === "win32"
      ? ["winget"]
      : ["sudo", "apt-get", "dnf", "yum", "pacman", "zypper"];
  const install = ripgrepInstallCommand(platform, await detectAvailableCommands(candidates));
  if (!install) {
    console.log(`WARN no supported ripgrep installer found. ${ripgrepManualInstallHint(platform)}`);
    return false;
  }
  try {
    await runChecked("ripgrep", install.command, install.args);
  } catch (error) {
    console.log(`WARN ripgrep install via ${install.label} failed: ${error.message}`);
    console.log(ripgrepManualInstallHint(platform));
    return false;
  }
  const verify = await capture(process.platform === "win32" ? "rg.exe" : "rg", ["--version"]);
  if (verify.code === 0) {
    console.log(`OK ${verify.stdout.split(/\r?\n/)[0]}`);
    return true;
  }
  console.log(`WARN ripgrep install finished but rg is not on PATH. ${ripgrepManualInstallHint(platform)}`);
  return false;
}

async function checkPrerequisites(platform = detectSetupPlatform()) {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
    throw new Error(`Node.js ${MIN_NODE_MAJOR}+ is required. Current version: ${process.version}`);
  }
  console.log(`OK node ${process.version}`);
  const npm = await capture(npmCommand(), ["--version"]);
  if (npm.code !== 0) throw new Error("npm was not found. Install Node.js with npm, then rerun setup.");
  console.log(`OK npm ${npm.stdout.trim()}`);
  const git = await capture(process.platform === "win32" ? "git.exe" : "git", ["--version"]);
  console.log(git.code === 0 ? `OK ${git.stdout.trim()}` : "WARN git not found; repo-root detection will use the current folder.");
  await ensureRipgrep(platform);
}

function openUrl(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function openKeyPages(rl) {
  const shouldOpen = await promptYesNo(rl, "Open OpenAI Tunnel and Runtime API key pages now", true);
  if (!shouldOpen) {
    for (const url of KEY_URLS) console.log(url);
    return;
  }
  for (const url of KEY_URLS) {
    if (!openUrl(url)) console.log(url);
  }
}

function printInstructionMode(selected, host) {
  console.log(`\nThis terminal is ${host.label}, but you selected ${selected.label}.`);
  console.log("Instruction mode only: no setup commands were run for the other OS.");
  console.log("\nRun this on the target OS instead:");
  if (selected.id === "win32") console.log("  scripts\\lca-custom.cmd setup");
  else console.log("  bash scripts/lca-custom setup");
  console.log("\nExpected tunnel-client asset:");
  console.log(`  ${tunnelAssetName(DEFAULT_TUNNEL_VERSION, selected.tunnelOs, selected.arch)}`);
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { "User-Agent": "local-coding-agent-setup" } });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchSha256ForAsset(version, assetName) {
  const url = `${TUNNEL_RELEASE_BASE}/${version}/SHA256SUMS.txt`;
  const res = await fetch(url, { headers: { "User-Agent": "local-coding-agent-setup" } });
  if (!res.ok) return "";
  const text = await res.text();
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const file = parts.slice(1).join(" ").replace(/^\*/, "");
    if (file === assetName) return parts[0].toLowerCase();
  }
  return "";
}

async function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    const ps = await capture("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`
    ]);
    if (ps.code === 0) return;
    const pwsh = await capture("pwsh", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`
    ]);
    if (pwsh.code === 0) return;
    throw new Error("Could not extract zip with PowerShell.");
  }
  const unzip = await capture("unzip", ["-qo", zipPath, "-d", destDir]);
  if (unzip.code !== 0) throw new Error("Could not extract zip. Install unzip or provide tunnel-client manually.");
}

function findBinary(root, names) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findBinary(full, names);
      if (found) return found;
    } else if (names.includes(entry.name)) {
      return full;
    }
  }
  return "";
}

async function downloadTunnelClient(selected, destination = defaultTunnelBinForPlatform(selected)) {
  const version = process.env.TUNNEL_CLIENT_VERSION || DEFAULT_TUNNEL_VERSION;
  const assetName = tunnelAssetName(version, selected.tunnelOs, selected.arch);
  const url = tunnelAssetUrl(version, selected.tunnelOs, selected.arch);
  const tmp = mkdtempSync(join(os.tmpdir(), "lca-tunnel-"));
  try {
    mkdirSync(dirname(destination), { recursive: true });
    const zipPath = join(tmp, assetName);
    console.log(`Downloading ${assetName}`);
    const data = await fetchBuffer(url);
    const expected = await fetchSha256ForAsset(version, assetName);
    if (expected) {
      const actual = sha256(data);
      if (actual !== expected) throw new Error(`SHA256 mismatch for ${assetName}`);
      console.log("OK sha256 verified");
    } else {
      console.log("WARN SHA256SUMS entry not found; continuing without checksum verification.");
    }
    writeFileSync(zipPath, data);
    const extractDir = join(tmp, "extract");
    await extractZip(zipPath, extractDir);
    const binary = findBinary(extractDir, [selected.executable, "tunnel-client", "tunnel-client.exe"]);
    if (!binary) throw new Error(`Could not find ${selected.executable} inside ${assetName}`);
    writeFileSync(destination, readFileSync(binary));
    try { await chmod(destination, 0o755); } catch { /* Windows may ignore POSIX mode. */ }
    console.log(`Installed tunnel-client: ${destination}`);
    return destination;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function defaultCliBinDir() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "LocalCodingAgentCustom", "bin");
  }
  return join(home, ".local", "bin");
}

function canWriteDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.lca-custom-write-test-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function cliBinCandidates() {
  if (process.env.LCA_CUSTOM_BIN_DIR) return [process.env.LCA_CUSTOM_BIN_DIR];
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  if (process.platform === "win32") return [defaultCliBinDir()];
  return [
    defaultCliBinDir(),
    join(home, "bin"),
    join(dirname(CONFIG_PATH), "bin")
  ];
}

function chooseCliBinDir() {
  for (const dir of cliBinCandidates()) {
    if (canWriteDir(dir)) return dir;
  }
  return defaultCliBinDir();
}

function pathEnvKey() {
  return Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";
}

function getProcessPath() {
  return process.env[pathEnvKey()] || "";
}

function setProcessPath(value) {
  const key = pathEnvKey();
  process.env[key] = value;
  process.env.PATH = value;
}

function prependProcessPath(dir) {
  const current = getProcessPath();
  const sep = process.platform === "win32" ? ";" : ":";
  setProcessPath(current ? `${dir}${sep}${current}` : dir);
}

function normalizePathForCompare(value) {
  const resolved = resolve(String(value || ""));
  return process.platform === "win32"
    ? resolved.replace(/[\\/]+$/, "").toLowerCase()
    : resolved;
}

function pathHasDir(dir) {
  const target = normalizePathForCompare(dir);
  return getProcessPath()
    .split(process.platform === "win32" ? ";" : ":")
    .some((entry) => entry && normalizePathForCompare(entry) === target);
}

function shellProfileCandidates() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const shell = basename(process.env.SHELL || "");
  if (shell === "zsh") return [join(home, ".zshrc")];
  if (shell === "fish") return [join(home, ".config", "fish", "config.fish")];
  if (shell === "bash") {
    if (process.platform === "darwin") return [join(home, ".bash_profile"), join(home, ".bashrc")];
    return [join(home, ".bashrc"), join(home, ".profile")];
  }
  return [join(home, ".zshrc"), join(home, ".bashrc"), join(home, ".profile")];
}

function pathExportLine(dir, profilePath) {
  if (profilePath.endsWith("config.fish")) return `fish_add_path "${dir}"`;
  return `export PATH="${dir}:$PATH"`;
}

async function setWindowsUserPath(binDir) {
  const script = `
$ErrorActionPreference = 'Stop'
$dir = [System.IO.Path]::GetFullPath($args[0])
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $userPath) { $userPath = '' }
$exists = $false
foreach ($part in ($userPath -split ';')) {
  if ([string]::IsNullOrWhiteSpace($part)) { continue }
  try { $full = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($part)) } catch { $full = $part }
  if ($full.TrimEnd('\\') -ieq $dir.TrimEnd('\\')) { $exists = $true; break }
}
if (-not $exists) {
  $newPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $dir } else { "$userPath;$dir" }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Output 'added'
} else {
  Write-Output 'exists'
}
`;
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script, binDir];
  let result = await capture("powershell.exe", args);
  if (result.code !== 0) result = await capture("pwsh", ["-NoProfile", "-Command", script, binDir]);
  return result;
}

async function configureShellPath(binDir) {
  if (pathHasDir(binDir)) return { changed: false, active: true, profile: "" };
  if (process.platform === "win32") {
    prependProcessPath(binDir);
    const result = await setWindowsUserPath(binDir);
    if (result.code === 0) {
      const changed = result.stdout.includes("added");
      return {
        changed,
        active: false,
        profile: "User PATH",
        message: `${changed ? "Added" : "Already present in"} Windows User PATH: ${binDir}. Open a new terminal before running lca-custom.`
      };
    }
    return {
      changed: false,
      active: false,
      profile: "",
      message: `Could not update Windows User PATH automatically. Add this directory manually: ${binDir}`
    };
  }

  const profile = shellProfileCandidates()[0];
  mkdirSync(dirname(profile), { recursive: true });
  const existing = existsSync(profile) ? readFileSync(profile, "utf8") : "";
  const line = pathExportLine(binDir, profile);
  if (!existing.includes(binDir) && !existing.includes(line)) {
    const block = `\n# Local Coding Agent CLI\n${line}\n`;
    writeFileSync(profile, `${existing.replace(/\s*$/, "")}${block}`, "utf8");
  }
  prependProcessPath(binDir);
  return { changed: true, active: false, profile, message: `Added ${binDir} to ${profile}. Restart your terminal or run: source ${profile}` };
}

async function verifyCliShim(cliPath) {
  const result = process.platform === "win32"
    ? await capture("cmd.exe", ["/d", "/c", `call "${cliPath}" --help`], { cwd: REPO_ROOT })
    : await capture(cliPath, ["--help"], { cwd: REPO_ROOT });
  if (result.code !== 0) {
    throw new Error(`Installed ${CLI_NAME} wrapper failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }
  console.log(`OK ${CLI_NAME} wrapper: ${cliPath}`);
}

function bashSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function powershellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function batchQuotedValue(value) {
  return String(value).replace(/%/g, "%%");
}

export function cliWrapperContents({ marker, scriptPath, configPath }) {
  const bash = `#!/usr/bin/env bash\n# ${marker}\nexport LCA_CUSTOM_CONFIG_PATH=${bashSingleQuote(configPath)}\nexec node ${bashSingleQuote(scriptPath)} "$@"\n`;
  const cmd = `@echo off\r\nrem ${marker}\r\nwhere node >nul 2>nul\r\nif errorlevel 1 (\r\n  echo ERROR: Node.js 20+ is required but node was not found in PATH.\r\n  echo Install Node.js LTS from https://nodejs.org/ then open a new terminal and rerun setup.\r\n  exit /b 1\r\n)\r\nset "LCA_CUSTOM_CONFIG_PATH=${batchQuotedValue(configPath)}"\r\nnode "${batchQuotedValue(scriptPath)}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
  const powershell = `# ${marker}\n$env:LCA_CUSTOM_CONFIG_PATH = ${powershellSingleQuote(configPath)}\n& node ${powershellSingleQuote(scriptPath)} @args\nexit $LASTEXITCODE\n`;
  return { bash, cmd, powershell };
}

async function installCliCommand() {
  const marker = `local-coding-agent ${CLI_NAME} wrapper`;
  const wrapper = cliWrapperContents({
    marker,
    scriptPath: join(SCRIPT_DIR, "local-coding-agent.mjs"),
    configPath: CONFIG_PATH
  });
  const preferredBinDir = process.env.LCA_CUSTOM_BIN_DIR || defaultCliBinDir();
  const binDir = chooseCliBinDir();
  if (binDir !== preferredBinDir) {
    console.log(`WARN ${preferredBinDir} is not writable; installing ${CLI_NAME} into ${binDir} instead.`);
  }
  mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    const cmdPath = join(binDir, `${CLI_NAME}.cmd`);
    const psPath = join(binDir, `${CLI_NAME}.ps1`);
    for (const target of [cmdPath, psPath]) {
      if (existsSync(target) && !readFileSync(target, "utf8").includes(marker)) {
        throw new Error(`Refusing to overwrite: ${target}`);
      }
    }
    writeFileSync(cmdPath, wrapper.cmd, "utf8");
    writeFileSync(psPath, wrapper.powershell, "utf8");
    console.log(`Installed: ${cmdPath}`);
    const pathResult = await configureShellPath(binDir);
    if (pathResult.message) console.log(pathResult.message);
    if (!pathResult.active) console.log(`Current terminal fallback: "${cmdPath}"`);
    return cmdPath;
  }
  const target = join(binDir, CLI_NAME);
  if (existsSync(target) && !readFileSync(target, "utf8").includes(marker)) {
    throw new Error(`Refusing to overwrite: ${target}`);
  }
  writeFileSync(target, wrapper.bash, "utf8");
  await chmod(target, 0o755);
  console.log(`Installed: ${target}`);
  const pathResult = await configureShellPath(binDir);
  if (pathResult.message) console.log(pathResult.message);
  return target;
}

async function setup(flags) {
  if (flags.help) return setupUsage();
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive terminal required. Run `lca-custom setup` from a terminal.");
  }
  const cfg = effectiveOptions(flags);
  const rl = createPromptInterface({ input, output });
  try {
    const host = detectSetupPlatform();
    const selected = flags.chooseOs
      ? await promptChoice(rl, "Choose target operating system", setupPlatformChoices(), host.id)
      : host;
    if (!platformMatchesHost(selected, host)) {
      printInstructionMode(selected, host);
      return;
    }

    console.log(`Detected OS: ${selected.label}`);
    console.log(`Config file: ${CONFIG_PATH}`);
    console.log(`Environment file: ${ENV_LOCAL_PATH}`);

    printStep(1, 9, "Check prerequisites");
    await checkPrerequisites(selected);

    printStep(2, 9, "Choose tunnel mode");
    const useTunnel = await promptYesNo(rl, "Use ChatGPT Web tunnel", !cfg.noTunnel);
    cfg.noTunnel = !useTunnel;
    if (useTunnel) await openKeyPages(rl);

    printStep(3, 9, "Configure local environment");
    const envValues = readRepoEnvFile();
    if (useTunnel) {
      cfg.tunnelId = await promptLine(rl, "Tunnel ID", flags.tunnelId || (!isPlaceholder(envValues.CONTROL_PLANE_TUNNEL_ID) ? envValues.CONTROL_PLANE_TUNNEL_ID : cfg.tunnelId));
      const currentKey = !isPlaceholder(envValues.CONTROL_PLANE_API_KEY) ? envValues.CONTROL_PLANE_API_KEY : "";
      const runtimeKey = await promptSecretRequired(rl, "Runtime API key", flags.runtimeKey || currentKey);
      if (!cfg.tunnelId) throw new Error("Tunnel ID is required when tunnel mode is enabled.");
      if (!runtimeKey) throw new Error("Runtime API key is required when tunnel mode is enabled.");
      await writeRepoEnv({
        CONTROL_PLANE_TUNNEL_ID: cfg.tunnelId,
        CONTROL_PLANE_API_KEY: runtimeKey
      });
      cfg.runtimeKeyEnv = "CONTROL_PLANE_API_KEY";
      cfg.runtimeKey = "";
      console.log("Saved .env.local");
    } else if (!existsSync(ENV_LOCAL_PATH) && existsSync(ENV_EXAMPLE_PATH)) {
      await writeFile(ENV_LOCAL_PATH, readFileSync(ENV_EXAMPLE_PATH, "utf8"), "utf8");
      console.log("Created .env.local from .env.example");
    } else {
      console.log("Tunnel disabled; .env.local can be filled later.");
    }

    printStep(4, 9, "Configure trusted local runtime");
    cfg.node = cfg.node || "node";
    cfg.workspace = await promptLine(rl, "First project root", cfg.workspace || process.cwd());
    cfg.port = await promptLine(rl, "MCP port", cfg.port || DEFAULT_PORT);
    console.log("Runtime: trusted-local, compact 14-tool facade, direct execution without policy or approval round-trips.");
    cfg.extraRoots = flags.extraRoots ?? cfg.extraRoots ?? "";
    cfg.authToken = flags.authToken ?? cfg.authToken ?? "";

    printStep(5, 9, "Install managed runtime");
    await installManagedRuntimeCommand({ ...flags, json: false });

    printStep(6, 9, "Connect Figma Desktop MCP");
    const useFigmaDesktop = await promptYesNo(rl, "Enable Figma Desktop integration", true);
    if (useFigmaDesktop) {
      await ensureFigmaDesktopConnected(rl, { interactive: true, failOnMissing: false });
    } else {
      console.log("Skipped. Run `lca-custom figma` later.");
    }

    printStep(7, 9, "Install tunnel-client");
    if (useTunnel) {
      cfg.tunnelBin = cfg.tunnelBin || defaultTunnelBinForPlatform(selected);
      if (!existsSync(cfg.tunnelBin)) {
        try {
          cfg.tunnelBin = await downloadTunnelClient(selected, cfg.tunnelBin);
        } catch (error) {
          console.log(`Download failed: ${error.message}`);
          cfg.tunnelBin = await promptLine(rl, "Manual tunnel-client path", cfg.tunnelBin);
          if (!existsSync(cfg.tunnelBin)) throw new Error(`Tunnel client not found: ${cfg.tunnelBin}`);
        }
      } else {
        console.log(`Using existing tunnel-client: ${cfg.tunnelBin}`);
      }
      cfg.profileDir = cfg.profileDir || join(REPO_ROOT, "tools", "profiles");
      cfg.profile = cfg.profile || "local-coding-agent-custom";
      cfg.organizationId = flags.organizationId || cfg.organizationId || "";
    } else {
      console.log("Tunnel disabled.");
    }

    printStep(8, 9, "Save config and install lca-custom command");
    cfg.runtimeKey = "";
    const normalizedCfg = normalize(cfg);
    validate(normalizedCfg);
    await saveConfig(stripRuntimeFields(normalizedCfg));
    const cliPath = await installCliCommand();

    printStep(9, 9, "Verify");
    await verifyCliShim(cliPath);
    await status({ json: false });
    console.log("\nSetup complete.");
    console.log("Daily use:");
    console.log("  lca-custom add /path/to/another-project");
    console.log("  lca-custom start --background");
    console.log(`Health: http://127.0.0.1:${cfg.port}/healthz`);
  } finally {
    rl.close();
  }
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
    cwd: SERVER_DIR
  };
}

function managedRuntimeOptions(overrides = {}) {
  return {
    paths: MANAGED_RUNTIME_PATHS,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    agentMemoryUrl: process.env.AGENTMEMORY_URL || "http://127.0.0.1:3111",
    ...overrides
  };
}

async function runManagedRuntimeCommand(command, args, options = {}) {
  const label = options.cwd === MANAGED_RUNTIME_PATHS.memoryDirectory
    ? "agentmemory"
    : args.includes("build:next")
      ? "build-next"
      : "server-deps";
  await runChecked(label, command, args, {
    cwd: options.cwd,
    env: options.env
  });
  return { code: 0, signal: null, stdout: "", stderr: "" };
}

async function runManagedRuntimeQuiet(command, args, options = {}) {
  const result = await capture(command, args, { cwd: options.cwd, env: options.env });
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.code}: ${result.stderr || result.stdout}`);
  }
  return result;
}

async function installManagedRuntimeCommand(flags = {}) {
  const quiet = flags.quiet === true || flags.json === true;
  const result = await installManagedRuntime(managedRuntimeOptions({
    force: flags.force === true,
    probeEngine: flags.probeEngine,
    probeServices: flags.probeServices,
    run: quiet ? runManagedRuntimeQuiet : runManagedRuntimeCommand,
    log: (message) => {
      if (!quiet) console.log(`[runtime] ${message}`);
    }
  }));
  if (flags.json) {
    console.log(JSON.stringify({
      kind: "managed_runtime_install",
      plan: result.plan,
      repaired: result.plan.installServer || result.plan.installAgentMemory || result.plan.patchAgentMemory || result.plan.initializeAgentMemory,
      rebuilt: result.plan.buildCompactRuntime,
      receipt: result.after
    }, null, 2));
  } else if (!quiet) {
    printManagedRuntimeReceipt(result.after);
  }
  return result.after;
}

async function managedRuntimeFastReport() {
  return inspectManagedRuntime(managedRuntimeOptions({
    probeEngine: false,
    probeServices: false
  }));
}

async function stopManagedServerForRepair(opts, { quiet = false } = {}) {
  const state = readPidState();
  const health = await readJson(`http://127.0.0.1:${opts.port}/healthz`);
  const serverPid = health?.pid || state.serverPid;
  if (!serverPid || !isPidAlive(serverPid)) return false;
  if (!quiet) console.log(`[runtime] stopping server PID ${serverPid} before replacing dependencies`);
  killPid(serverPid);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && isPidAlive(serverPid)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (isPidAlive(serverPid)) throw new Error(`Server PID ${serverPid} did not exit before managed runtime repair.`);
  return true;
}

async function ensureManagedRuntime(opts) {
  const before = await managedRuntimeFastReport();
  const plan = runtimeInstallPlan(before);
  if (plan.installServer || plan.installAgentMemory || plan.patchAgentMemory) {
    await stopManagedServerForRepair(opts, { quiet: true });
  }
  return installManagedRuntimeCommand({
    quiet: true,
    force: false,
    probeEngine: false,
    probeServices: false
  });
}

async function withMutedConsoleLog(operation) {
  const original = console.log;
  console.log = () => {};
  try {
    return await operation();
  } finally {
    console.log = original;
  }
}

async function installCommand(flags) {
  const opts = effectiveOptions(flags);
  const before = await managedRuntimeFastReport();
  const plan = runtimeInstallPlan(before, { force: flags.force === true });
  const needsReplacement = plan.installServer || plan.installAgentMemory || plan.patchAgentMemory;
  const stoppedServer = needsReplacement
    ? await stopManagedServerForRepair(opts, { quiet: flags.json === true })
    : false;
  const receipt = await installManagedRuntimeCommand(flags);
  if (stoppedServer) {
    const restart = () => start({ ...opts, background: true, skipManagedRuntime: true });
    if (flags.json) await withMutedConsoleLog(restart);
    else await restart();
  }
  return receipt;
}

async function runChecked(label, command, args, options = {}) {
  const child = spawnLogged(label, command, args, options);
  const code = await new Promise((resolveExit) => child.on("exit", resolveExit));
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
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolveCapture({ code: 127, signal: null, stdout, stderr: error.message }));
    child.on("exit", (code, signal) => resolveCapture({ code, signal, stdout, stderr }));
  });
}

async function updateSelf(flags) {
  const git = process.platform === "win32" ? "git.exe" : "git";
  const currentConfig = effectiveOptions(flags);
  const runningBefore = await runningStatusForConfig(currentConfig);
  const before = await capture(git, ["status", "--short", "--branch"], { cwd: REPO_ROOT });
  if (before.code !== 0) throw new Error(`git status failed: ${before.stderr || before.stdout}`);
  console.log(before.stdout.trim() || "working tree clean");
  const dirtyLines = before.stdout.split(/\r?\n/).filter((line) => line && !line.startsWith("##"));
  if (dirtyLines.length && !flags.force) {
    throw new Error("Local changes detected. Review them first, then rerun with --force only if you want to proceed.");
  }
  if (runningBefore.running) await stop(currentConfig);
  await runChecked("git", git, ["fetch", "origin", "main", "--tags"], { cwd: REPO_ROOT });
  const incoming = await capture(git, ["log", "--oneline", "--decorate", "--max-count=10", "HEAD..origin/main"], { cwd: REPO_ROOT });
  if (incoming.stdout.trim()) {
    console.log("\nIncoming changes:");
    console.log(incoming.stdout.trim());
  } else {
    console.log("\nAlready up to date with origin/main.");
  }
  await runChecked("git", git, ["pull", "--ff-only", "origin", "main"], { cwd: REPO_ROOT });
  await installManagedRuntimeCommand({ ...flags, force: true, json: false });
  await runChecked("check", process.execPath, ["--check", join(SCRIPT_DIR, "local-coding-agent.mjs")], { cwd: REPO_ROOT });
  await runChecked("check", process.execPath, ["--check", join(SCRIPT_DIR, "network-doctor.mjs")], { cwd: REPO_ROOT });
  await runChecked("skills", process.execPath, [join(SCRIPT_DIR, "validate-skills.mjs")], { cwd: REPO_ROOT });
  if (runningBefore.running) await start({ ...currentConfig, background: true, skipManagedRuntime: true });
  await doctor(flags);
  console.log("\nUpdate complete.");
}

async function start(flags) {
  const releaseStartLock = await acquireStartLock();
  let serverChild = null;
  let tunnelChild = null;
  try {
    const opts = effectiveOptions(flags);
    validate(opts, { requireWorkspace: true, requireTunnel: true });
    if (!existsSync(join(SERVER_DIR, SERVER_SCRIPT))) throw new Error(`Missing ${SERVER_SCRIPT} in ${SERVER_DIR}`);
    if (!flags.skipManagedRuntime) await ensureManagedRuntime(opts);
    if (flags.save) await saveConfig(stripRuntimeFields(opts));

    const id = configId(opts);
    const healthUrl = `http://127.0.0.1:${opts.port}/healthz`;
    let health = await readJson(healthUrl);
    if (health?.status === "ok" && health.config_id !== id) {
      console.log(`[server] existing server config differs; stopping PID ${health.pid}`);
      killPid(health.pid);
      await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
      health = null;
    }

    const state = readPidState();
    if (!health) {
      const env = {
        ...process.env,
        PORT: String(opts.port),
        AGENT_HOST: "127.0.0.1",
        AGENT_WORKSPACE: opts.workspace,
        AGENT_CONFIG_ID: id,
        AGENT_EXTRA_ROOTS: opts.extraRoots || "",
        AGENT_EXTRA_ROOTS_JSON: JSON.stringify(opts.projects.slice(1)),
        MCP_AUTH_TOKEN: opts.authToken || ""
      };
      const stdio = flags.background ? ["ignore", "ignore", "ignore"] : "inherit";
      serverChild = spawnLogged("server", opts.node, [SERVER_SCRIPT], {
        cwd: SERVER_DIR,
        env,
        detached: Boolean(flags.background),
        stdio
      });
      if (flags.background) serverChild.unref();
      health = await waitForHealth(opts.port);
      if (!health) throw new Error(`MCP server did not respond at ${healthUrl}`);
      state.serverPid = health.pid || serverChild.pid;
    } else {
      state.serverPid = health.pid;
    }

    console.log(`[server] MCP OK:    http://127.0.0.1:${opts.port}/mcp`);
    console.log(`[server] Version:   ${health.version || "unknown"} ${health.tier ? `(${health.tier})` : ""}`);

    if (!opts.noTunnel) {
      const runtimeKey = flags.runtimeKey || process.env[opts.runtimeKeyEnv] || opts.runtimeKey;
      if (!runtimeKey) {
        throw new Error(`Missing Runtime API key. Set ${opts.runtimeKeyEnv}, pass --runtime-key, or run key set.`);
      }
      const profilePath = writeTunnelProfile(opts);
      console.log(`[tunnel] Profile: ${profilePath}`);

      const managed = await findManagedTunnelProcesses(opts);
      const keeper = chooseManagedTunnelKeeper(managed, state, { configId: id, port: opts.port });
      for (const entry of managed) {
        if (keeper && entry.pid === keeper.pid) continue;
        console.log(`[tunnel] removing duplicate or stale PID ${entry.pid}`);
        const stopped = await stopManagedTunnel(entry, opts);
        if (!stopped) throw new Error(`Unable to stop stale tunnel process PID ${entry.pid}.`);
      }

      if (keeper && isPidAlive(keeper.pid)) {
        state.tunnelPid = keeper.pid;
        console.log(`[tunnel] reusing singleton PID ${keeper.pid}`);
      } else {
        const env = {
          ...process.env,
          CONTROL_PLANE_API_KEY: runtimeKey,
          CONTROL_PLANE_TUNNEL_ID: opts.tunnelId
        };
        if (opts.authToken) {
          env.MCP_AUTH_HEADER = `Bearer ${opts.authToken}`;
          env.MCP_EXTRA_HEADERS = "Authorization: env:MCP_AUTH_HEADER";
        }
        const args = [
          "run",
          "--profile", opts.profile,
          "--profile-dir", opts.profileDir,
          "--control-plane.tunnel-id", opts.tunnelId,
          ...tunnelHealthArgs()
        ];
        const stdio = flags.background ? ["ignore", "ignore", "ignore"] : "inherit";
        tunnelChild = spawnLogged("tunnel", opts.tunnelBin, args, {
          cwd: dirname(opts.tunnelBin),
          env,
          detached: Boolean(flags.background),
          stdio
        });
        if (flags.background) tunnelChild.unref();
        state.tunnelPid = tunnelChild.pid;
      }
    } else {
      for (const entry of await findManagedTunnelProcesses(opts)) {
        console.log(`[tunnel] stopping disabled tunnel PID ${entry.pid}`);
        await stopManagedTunnel(entry, opts);
      }
      delete state.tunnelPid;
    }
    state.updatedAt = new Date().toISOString();
    state.configId = id;
    state.port = opts.port;
    await writePidState(state);
  } finally {
    releaseStartLock();
  }

  if (flags.background) {
    console.log("Running in background.");
    return;
  }

  const stopChildren = () => {
    if (tunnelChild && !tunnelChild.killed) tunnelChild.kill("SIGTERM");
    if (serverChild && !serverChild.killed) serverChild.kill("SIGTERM");
  };
  process.on("SIGINT", () => {
    stopChildren();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    stopChildren();
    process.exit(143);
  });

  if (tunnelChild) {
    await new Promise((resolveExit) => tunnelChild.on("exit", resolveExit));
  } else if (serverChild) {
    await new Promise((resolveExit) => serverChild.on("exit", resolveExit));
  }
}

async function stop(flags) {
  const releaseStartLock = await acquireStartLock();
  try {
    const opts = effectiveOptions(flags);
    const state = readPidState();
    const health = await readJson(`http://127.0.0.1:${opts.port}/healthz`);
    const managed = await findManagedTunnelProcesses(opts);
    for (const entry of managed) {
      console.log(`[tunnel] stopping PID ${entry.pid}`);
      await stopManagedTunnel(entry, opts);
    }
    const serverPid = health?.pid || state.serverPid;
    if (serverPid && isPidAlive(serverPid)) {
      console.log(`[server] stopping PID ${serverPid}`);
      killPid(serverPid);
    }
    try { rmSync(PID_PATH, { force: true }); } catch { /* ignore */ }
    console.log("Stopped.");
  } finally {
    releaseStartLock();
  }
}

async function runningStatusForConfig(cfg = effectiveOptions()) {
  const state = readPidState();
  const health = await readJson(`http://127.0.0.1:${cfg.port}/healthz`);
  return {
    state,
    health,
    running: Boolean(health?.status === "ok" || isPidAlive(state.serverPid) || isPidAlive(state.tunnelPid))
  };
}

async function restartIfRunning(beforeCfg, afterCfg) {
  const before = await runningStatusForConfig(beforeCfg);
  if (!before.running) return false;
  console.log("Config changed; restarting running agent...");
  await stop(beforeCfg);
  await start({ ...afterCfg, background: true });
  return true;
}

async function status(flags) {
  const opts = effectiveOptions(flags);
  const state = readPidState();
  const health = await readJson(`http://127.0.0.1:${opts.port}/healthz`);
  const managedTunnels = opts.noTunnel ? [] : await findManagedTunnelProcesses(opts);
  const data = {
    config_path: CONFIG_PATH,
    pid_path: PID_PATH,
    log_path: LOG_PATH,
    mcp_url: `http://127.0.0.1:${opts.port}/mcp`,
    projects: opts.projects,
    server: health || null,
    pids: {
      server: state.serverPid || null,
      server_alive: isPidAlive(state.serverPid),
      tunnel: state.tunnelPid || null,
      tunnel_alive: isPidAlive(state.tunnelPid),
      managed_tunnels: managedTunnels.map((entry) => entry.pid),
      tunnel_count: managedTunnels.length,
      tunnel_duplicates: Math.max(0, managedTunnels.length - 1)
    }
  };
  if (flags.json) console.log(JSON.stringify(data, null, 2));
  else {
    console.log(`Config:    ${data.config_path}`);
    console.log(`MCP URL:   ${data.mcp_url}`);
    console.log(`Projects:  ${data.projects.length}`);
    for (const project of data.projects) console.log(`  - ${project}`);
    console.log(`Server:    ${health ? `ONLINE ${health.version || ""} (${health.runtime || "trusted-local"}/${health.tool_surface || "compact"}) pid=${health.pid || "?"}` : "offline"}`);
    console.log(`Tunnel:    ${data.pids.tunnel_alive ? `running pid=${data.pids.tunnel}` : "unknown/offline"} managed=${data.pids.tunnel_count} duplicates=${data.pids.tunnel_duplicates}`);
  }
}

function printManagedRuntimeReceipt(receipt) {
  for (const check of receipt.checks) {
    const prefix = check.status === "pass" ? "OK " : check.status === "warn" ? "WARN" : "ERR";
    console.log(`${prefix} ${check.title}: ${check.detail}`);
  }
  console.log(`Managed runtime: ${receipt.status.toUpperCase()} (${receipt.summary.pass} pass, ${receipt.summary.warn} warn, ${receipt.summary.fail} fail)`);
}

async function doctor(flags) {
  const opts = effectiveOptions(flags);
  const runtime = await inspectManagedRuntime(managedRuntimeOptions());
  const checks = [];
  const add = (id, status, title, detail, repair = null) => checks.push({ id, status, title, detail, repair });
  add("server_directory", existsSync(SERVER_DIR) ? "pass" : "fail", "Server directory", SERVER_DIR);
  add("server_entry", existsSync(join(SERVER_DIR, SERVER_SCRIPT)) ? "pass" : "fail", "server.mjs", join(SERVER_DIR, SERVER_SCRIPT));
  add("projects", opts.projects.length > 0 ? "pass" : "fail", "Projects configured", opts.projects.length ? `${opts.projects.length} project(s)` : "none", "Run lca-custom add [path].");
  for (const project of opts.projects) add(`project:${project}`, isDirectory(project) ? "pass" : "fail", "Project root", project);
  add("tunnel_client", opts.noTunnel || existsSync(opts.tunnelBin) ? "pass" : "fail", "Tunnel client", opts.noTunnel ? "disabled" : opts.tunnelBin);
  add("runtime_key", opts.noTunnel || Boolean(process.env[opts.runtimeKeyEnv] || opts.runtimeKey) ? "pass" : "fail", "Runtime key", opts.noTunnel ? "disabled" : opts.runtimeKeyEnv);
  const rg = await capture(process.platform === "win32" ? "rg.exe" : "rg", ["--version"]);
  add("ripgrep", rg.code === 0 ? "pass" : "warn", "ripgrep", rg.code === 0 ? rg.stdout.split(/\r?\n/)[0] : "missing; search falls back to scanning");
  const health = await readJson(`http://127.0.0.1:${opts.port}/healthz`);
  add("server_health", health ? "pass" : "warn", "Server health", health ? `${health.version} pid=${health.pid || "?"} surface=${health.tool_surface || "?"}` : "offline");
  const managedTunnels = opts.noTunnel ? [] : await findManagedTunnelProcesses(opts);
  add(
    "tunnel_singleton",
    opts.noTunnel || managedTunnels.length === 1 ? "pass" : managedTunnels.length === 0 ? "warn" : "fail",
    "Tunnel singleton",
    opts.noTunnel ? "disabled" : `${managedTunnels.length} managed process(es): ${managedTunnels.map((entry) => entry.pid).join(", ") || "none"}`
  );

  const allChecks = [...runtime.checks, ...checks];
  const fail = allChecks.filter((check) => check.status === "fail").length;
  const warn = allChecks.filter((check) => check.status === "warn").length;
  const data = {
    kind: "lca_custom_doctor",
    status: fail ? "fail" : warn ? "warn" : "pass",
    ready: fail === 0,
    runtime,
    checks,
    summary: { pass: allChecks.filter((check) => check.status === "pass").length, warn, fail },
    server: health || null,
    projects: opts.projects,
    tunnel: {
      enabled: !opts.noTunnel,
      processes: managedTunnels.map((entry) => entry.pid)
    }
  };

  if (flags.json) console.log(JSON.stringify(data, null, 2));
  else {
    printManagedRuntimeReceipt(runtime);
    for (const check of checks) {
      const prefix = check.status === "pass" ? "OK " : check.status === "warn" ? "WARN" : "ERR";
      console.log(`${prefix} ${check.title}: ${check.detail}`);
    }
    console.log(`Doctor: ${data.status.toUpperCase()} (${data.summary.pass} pass, ${data.summary.warn} warn, ${data.summary.fail} fail)`);
  }
  if (fail) process.exitCode = 1;
  return data;
}

function redactConfigForDisplay(cfg) {
  const visible = { ...cfg };
  if (visible.runtimeKey) visible.runtimeKey = "<saved>";
  if (visible.authToken) visible.authToken = "<saved>";
  return visible;
}

async function promptConfigWizard() {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive terminal required. Use `lca-custom config show` for non-interactive output.");
  }
  const beforeCfg = normalize(loadConfig());
  const cfg = { ...beforeCfg };
  const rl = createPromptInterface({ input, output });
  let saved = false;
  try {
    while (true) {
      console.log("\nLocal Coding Agent config");
      console.log(`  Workspace: ${cfg.workspace || "(not set)"}`);
      console.log("  Runtime:   trusted-local / compact");
      console.log(`  MCP port:  ${cfg.port}`);
      console.log(`  Tunnel:    ${cfg.noTunnel ? "disabled" : "enabled"}`);
      console.log("");
      const action = await promptChoice(rl, "Choose what to change", [
        { id: "workspace", label: "Workspace path" },
        { id: "port", label: "MCP port" },
        { id: "tunnel", label: "Tunnel on/off" },
        { id: "show", label: "Show full config" },
        { id: "save", label: "Save and apply" },
        { id: "cancel", label: "Cancel" }
      ], "save");
      if (action.id === "workspace") {
        cfg.workspace = await promptLine(rl, "Workspace path", cfg.workspace || process.cwd());
      } else if (action.id === "port") {
        cfg.port = await promptLine(rl, "MCP port", cfg.port || DEFAULT_PORT);
      } else if (action.id === "tunnel") {
        cfg.noTunnel = await promptYesNo(rl, "Server only, no tunnel", cfg.noTunnel);
      } else if (action.id === "show") {
        console.log(JSON.stringify(redactConfigForDisplay(cfg), null, 2));
      } else if (action.id === "save") {
        const normalizedCfg = normalize(cfg);
        validate(normalizedCfg);
        await saveConfig(stripRuntimeFields(normalizedCfg));
        saved = true;
        console.log("Saved config.");
        const restarted = await restartIfRunning(beforeCfg, normalizedCfg);
        if (!restarted) console.log("Agent is not running; next `lca-custom` will use the new config.");
        break;
      } else if (action.id === "cancel") {
        console.log("Canceled.");
        break;
      }
    }
  } finally {
    rl.close();
  }
  return saved;
}

async function configCommand(rest) {
  const [sub, key, ...valueParts] = rest;
  const beforeCfg = normalize(loadConfig());
  const cfg = loadConfig();
  if (!sub) {
    return promptConfigWizard();
  }
  if (sub === "show") {
    console.log(JSON.stringify(redactConfigForDisplay(cfg), null, 2));
    return;
  }
  if (sub === "path") {
    console.log(CONFIG_PATH);
    return;
  }
  if (sub === "set") {
    if (!key || valueParts.length === 0) throw new Error("Usage: config set <key> <value>");
    cfg[key] = valueParts.join(" ");
    await saveConfig(cfg);
    console.log(`Set ${key}.`);
    await restartIfRunning(beforeCfg, normalize(cfg));
    return;
  }
  if (sub === "unset") {
    if (!key) throw new Error("Usage: config unset <key>");
    delete cfg[key];
    await saveConfig(cfg);
    console.log(`Unset ${key}.`);
    await restartIfRunning(beforeCfg, normalize(cfg));
    return;
  }
  throw new Error(`Unknown config command: ${sub}`);
}

async function keyCommand(rest) {
  const [sub] = rest;
  const cfg = loadConfig();
  if (sub === "clear") {
    cfg.runtimeKey = "";
    await saveConfig(cfg);
    console.log("Cleared saved runtime key.");
    return;
  }
  if (sub === "set") {
    const rl = createPromptInterface({ input, output });
    try {
      console.log("Warning: the universal CLI stores this key in a local config file, not DPAPI.");
      cfg.runtimeKey = await promptSecretUpdate(rl, "Runtime API key", cfg.runtimeKey);
      await saveConfig(cfg);
      console.log("Saved runtime key.");
    } finally {
      rl.close();
    }
    return;
  }
  throw new Error("Usage: key set|clear");
}



function figmaDesktopEndpoint() {
  return String(process.env.FIGMA_DESKTOP_MCP_URL || DEFAULT_FIGMA_DESKTOP_MCP_URL).trim();
}

async function loadFigmaDesktopBridge() {
  if (!existsSync(join(SERVER_DIR, "node_modules"))) {
    throw new Error("Figma bridge dependencies are missing. Run `lca-custom setup` or `lca-custom install` first.");
  }
  return import(pathToFileURL(join(SERVER_DIR, "figma-desktop.mjs")).href);
}

async function figmaDesktopStatusCli() {
  const bridge = await loadFigmaDesktopBridge();
  return bridge.figmaDesktopStatus({ endpoint: figmaDesktopEndpoint() });
}

async function listFigmaDesktopToolsCli() {
  const bridge = await loadFigmaDesktopBridge();
  return bridge.listFigmaDesktopTools({ endpoint: figmaDesktopEndpoint() });
}

function printFigmaDesktopEnableSteps(statusValue = {}) {
  console.log(`Figma Desktop MCP: ${statusValue.endpoint || DEFAULT_FIGMA_DESKTOP_MCP_URL}`);
  console.log("  1. Open the Figma desktop app and sign in.");
  console.log("  2. Open a Figma Design file.");
  console.log("  3. Switch to Dev Mode (Shift+D).");
  console.log('  4. In the MCP server section, click "Enable desktop MCP server".');
}

function openFigmaDesktop() {
  try {
    if (process.platform === "darwin") {
      const child = spawn("open", ["-a", "Figma"], { stdio: "ignore", detached: true, windowsHide: true });
      child.unref();
      return true;
    }
    return openUrl("figma://");
  } catch {
    return false;
  }
}

async function ensureFigmaDesktopConnected(rl, { interactive = false, failOnMissing = false } = {}) {
  let statusValue = await figmaDesktopStatusCli();
  if (statusValue.connected) {
    console.log(`Figma Desktop MCP connected: ${statusValue.endpoint}`);
    console.log(`Tools: ${statusValue.tools.join(", ") || "none"}`);
    return statusValue;
  }

  console.log(statusValue.error || "Figma Desktop MCP is not available.");
  printFigmaDesktopEnableSteps(statusValue);
  if (interactive) {
    if (openFigmaDesktop()) console.log("Opened Figma Desktop.");
    await rl.question("Enable the MCP server in Figma, then press Enter to retry: ");
    statusValue = await figmaDesktopStatusCli();
    if (statusValue.connected) {
      console.log(`Figma Desktop MCP connected: ${statusValue.endpoint}`);
      console.log(`Tools: ${statusValue.tools.join(", ") || "none"}`);
      return statusValue;
    }
    console.log(statusValue.error || "Figma Desktop MCP is still unavailable.");
  }

  if (failOnMissing) throw new Error(statusValue.error || "Figma Desktop MCP is not available.");
  console.log("You can finish later with: lca-custom figma");
  return statusValue;
}

function agentMemoryPortabilityOptions() {
  const baseUrl = process.env.AGENTMEMORY_URL || "http://127.0.0.1:3111";
  const service = new ManagedAgentMemoryService({
    paths: AGENTMEMORY_PORTABILITY_PATHS,
    baseUrl
  });
  return {
    paths: AGENTMEMORY_PORTABILITY_PATHS,
    baseUrl,
    secret: process.env.AGENTMEMORY_SECRET || "",
    service,
    lcaVersion: LCA_VERSION
  };
}

function printMemoryReceipt(receipt) {
  if (receipt.kind === "agentmemory_export") {
    console.log(`AgentMemory backup: ${receipt.path}`);
    console.log(`Checksum: ${receipt.checksum}`);
    console.log(`Sessions: ${receipt.counts.sessions}, observations: ${receipt.counts.observations}, memories: ${receipt.counts.memories}`);
    return;
  }
  if (receipt.kind === "agentmemory_import") {
    console.log(`${receipt.dry_run ? "Validated" : "Imported"}: ${receipt.input}`);
    console.log(`Strategy: ${receipt.strategy}; checksum: ${receipt.checksum}`);
    if (receipt.pre_import_backup?.path) console.log(`Pre-import backup: ${receipt.pre_import_backup.path}`);
    if (receipt.result) console.log(`Result: ${JSON.stringify(receipt.result)}`);
    return;
  }
  if (receipt.kind === "agentmemory_portability_status") {
    console.log(`AgentMemory service: ${receipt.service.ready ? "healthy" : "offline"}`);
    console.log(`Backup directory: ${receipt.backup_directory}`);
    console.log(`Backups: ${receipt.backups.length}`);
    for (const backup of receipt.backups.slice(0, 10)) console.log(`  - ${backup.path} (${backup.bytes} bytes)`);
  }
}

async function memoryCommand(rest, flags = {}) {
  const [sub = "status", file, ...extra] = rest;
  if (extra.length > 0) throw new Error("Too many memory command arguments.");
  const common = agentMemoryPortabilityOptions();

  if (sub === "status") {
    if (file) throw new Error("Usage: lca-custom memory status [--json]");
    const receipt = await agentMemoryPortabilityStatus(common);
    if (flags.json) console.log(JSON.stringify(receipt, null, 2));
    else printMemoryReceipt(receipt);
    return receipt;
  }

  if (sub === "export") {
    await ensureManagedRuntime(effectiveOptions(flags));
    const receipt = await exportAgentMemoryBackup({
      ...common,
      ...(file ? { outputPath: resolve(file) } : {})
    });
    if (flags.json) console.log(JSON.stringify(receipt, null, 2));
    else printMemoryReceipt(receipt);
    return receipt;
  }

  if (sub === "import") {
    if (!file) throw new Error("Usage: lca-custom memory import <file> [--dry-run] [--strategy skip|merge|replace] [--force] [--json]");
    const strategy = String(flags.strategy || "skip").toLowerCase();
    if (strategy === "replace" && flags.force !== true) {
      throw new Error("AgentMemory replace import requires --force because it clears existing memory state.");
    }
    if (!flags.dryRun) await ensureManagedRuntime(effectiveOptions(flags));
    const receipt = await importAgentMemoryBackup({
      ...common,
      inputPath: resolve(file),
      strategy,
      dryRun: flags.dryRun === true
    });
    if (flags.json) console.log(JSON.stringify(receipt, null, 2));
    else printMemoryReceipt(receipt);
    return receipt;
  }

  throw new Error("Usage: lca-custom memory status|export [file]|import <file>");
}

async function figmaCommand(rest, flags = {}) {
  const [sub = "connect"] = rest;
  if (sub === "status") {
    console.log(JSON.stringify(await figmaDesktopStatusCli(), null, 2));
    return;
  }
  if (sub === "tools") {
    const listed = await listFigmaDesktopToolsCli();
    console.log(JSON.stringify({ endpoint: figmaDesktopEndpoint(), count: listed.tools.length, tools: listed.tools }, null, 2));
    return;
  }
  if (sub === "open") {
    if (!openFigmaDesktop()) console.log("Could not open Figma automatically.");
    printFigmaDesktopEnableSteps({ endpoint: figmaDesktopEndpoint() });
    return;
  }
  if (sub !== "connect" && sub !== "check") {
    throw new Error("Usage: lca-custom figma [connect|status|tools|open]");
  }

  if (!input.isTTY || !output.isTTY) {
    const statusValue = await figmaDesktopStatusCli();
    console.log(JSON.stringify(statusValue, null, 2));
    if (!statusValue.connected) process.exitCode = 1;
    return;
  }

  const rl = createPromptInterface({ input, output });
  let statusValue;
  try {
    statusValue = await ensureFigmaDesktopConnected(rl, { interactive: true, failOnMissing: false });
  } finally {
    rl.close();
  }
  if (!statusValue.connected) {
    process.exitCode = 1;
    return;
  }

  const opts = effectiveOptions(flags);
  await restartIfRunning(opts, opts);
}

async function detectWorkspaceRoot(cwd = process.cwd()) {
  const git = process.platform === "win32" ? "git.exe" : "git";
  const result = await capture(git, ["-C", cwd, "rev-parse", "--show-toplevel"]);
  const root = result.code === 0 ? result.stdout.trim() : "";
  return root && existsSync(root) ? resolve(root) : resolve(cwd);
}

async function runCurrentWorkspace(flags) {
  const workspace = resolve(flags.workspace || await detectWorkspaceRoot());
  const opts = normalize({ ...effectiveOptions(flags), workspace });
  await saveConfig(stripRuntimeFields(opts));
  return start({ ...flags, workspace });
}

async function resolveProjectArgument(rest, flags = {}) {
  if (rest.length > 1) throw new Error("Expected at most one project path.");
  return resolve(rest[0] || flags.workspace || await detectWorkspaceRoot());
}

function effectiveProjectCommandOptions(flags = {}) {
  const configFlags = { ...flags };
  delete configFlags.workspace;
  delete configFlags.extraRoots;
  return effectiveOptions(configFlags);
}

function projectConfig(opts, projects) {
  const roots = normalizeProjectRoots({ projects });
  return normalize({
    ...opts,
    projects: roots,
    workspace: roots[0] || "",
    extraRoots: roots.slice(1).join(";")
  });
}

function printProjectList(projects) {
  console.log(`Projects: ${projects.length}`);
  for (const project of projects) console.log(`  - ${project}`);
}

async function addProjectCommand(rest, flags) {
  const before = effectiveProjectCommandOptions(flags);
  const project = await resolveProjectArgument(rest, flags);
  if (!isDirectory(project)) throw new Error(`Project directory does not exist: ${project}`);
  if (before.projects.includes(project)) {
    console.log(`Already added: ${project}`);
    printProjectList(before.projects);
    return;
  }
  const next = projectConfig(before, [...before.projects, project]);
  await saveConfig(stripRuntimeFields(next));
  console.log(`Added: ${project}`);
  printProjectList(next.projects);
  const restarted = await restartIfRunning(before, next);
  if (!restarted) console.log("Agent is offline. Start it with: lca-custom start --background");
}

async function removeProjectCommand(rest, flags) {
  const before = effectiveProjectCommandOptions(flags);
  const project = await resolveProjectArgument(rest, flags);
  if (!before.projects.includes(project)) {
    console.log(`Not registered: ${project}`);
    printProjectList(before.projects);
    return;
  }
  const next = projectConfig(before, before.projects.filter((item) => item !== project));
  await saveConfig(stripRuntimeFields(next));
  console.log(`Removed: ${project}`);
  printProjectList(next.projects);
  const running = await runningStatusForConfig(before);
  if (!running.running) return;
  if (!next.projects.length) {
    console.log("No projects remain; stopping the running agent.");
    await stop(before);
    return;
  }
  await restartIfRunning(before, next);
}

async function primaryProjectCommand(rest, flags) {
  const before = effectiveProjectCommandOptions(flags);
  const project = await resolveProjectArgument(rest, flags);
  if (!isDirectory(project)) throw new Error(`Project directory does not exist: ${project}`);
  if (before.projects[0] === project) {
    output.write(`Already primary: ${project}\n`);
    printProjectList(before.projects);
    return;
  }
  const nextProjects = promoteProjectRoot(before.projects, project);
  const next = projectConfig(before, nextProjects);
  await saveConfig(stripRuntimeFields(next));
  output.write(`Primary project: ${project}\n`);
  printProjectList(next.projects);
  const restarted = await restartIfRunning(before, next);
  if (!restarted) output.write("Agent is offline. Start it with: lca-custom start --background\n");
}

async function resetProjectsCommand(rest, flags) {
  const before = effectiveProjectCommandOptions(flags);
  const project = await resolveProjectArgument(rest, flags);
  if (!isDirectory(project)) throw new Error(`Project directory does not exist: ${project}`);
  const next = projectConfig(before, [project]);
  await saveConfig(stripRuntimeFields(next));
  console.log(`Reset projects to: ${project}`);
  const restarted = await restartIfRunning(before, next);
  if (!restarted) console.log("Agent is offline. Start it with: lca-custom start --background");
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function workspaceItems(current) {
  const items = [
    { label: "Select this folder", type: "select", path: current },
    { label: "Back ..", type: "open", path: dirname(current) }
  ];
  const children = readdirSync(current, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ".git" && !entry.name.startsWith("."))
    .map((entry) => join(current, entry.name))
    .sort((a, b) => basename(a).localeCompare(basename(b)));
  for (const child of children) {
    const repo = existsSync(join(child, ".git"));
    items.push({ label: `${basename(child)}/${repo ? "  [repo]" : ""}`, type: repo ? "select" : "open", path: child });
  }
  return items;
}

function renderWorkspacePicker(current, items, selected) {
  output.write("\x1b[H\x1b[2J\x1b[?25l");
  output.write("Choose workspace\n");
  output.write(`Path: ${current}\n\n`);
  output.write("Up/Down: move  Enter: select/open  q: quit\n\n");
  items.forEach((item, index) => {
    if (index === selected) output.write(`\x1b[7m> ${item.label}\x1b[0m\n`);
    else output.write(`  ${item.label}\n`);
  });
}

function readKeypress() {
  return new Promise((resolveKey) => {
    const onKey = (str, key = {}) => {
      input.off("keypress", onKey);
      resolveKey({ str, key });
    };
    input.on("keypress", onKey);
  });
}

async function pickWorkspace(startDir) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Interactive terminal required for workspace picker.");
  }
  let current = resolve(startDir);
  if (!isDirectory(current)) current = REPO_ROOT;
  let selected = 0;
  const wasRaw = input.isRaw;
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  try {
    while (true) {
      const items = workspaceItems(current);
      if (selected >= items.length) selected = 0;
      renderWorkspacePicker(current, items, selected);
      const { str, key } = await readKeypress();
      if (key.name === "up") selected = selected <= 0 ? items.length - 1 : selected - 1;
      else if (key.name === "down") selected = selected >= items.length - 1 ? 0 : selected + 1;
      else if (key.name === "return" || key.name === "enter") {
        const item = items[selected];
        if (item.type === "select") return resolve(item.path);
        current = resolve(item.path);
        selected = 0;
      } else if (str === "q" || str === "Q" || (key.ctrl && key.name === "c")) {
        return "";
      }
    }
  } finally {
    input.setRawMode(Boolean(wasRaw));
    output.write("\x1b[?25h\x1b[0m\n");
  }
}

async function workspaceCommand(flags) {
  const opts = effectiveOptions(flags);
  const startDir = flags.workspace || opts.workspace || process.cwd();
  const choice = await pickWorkspace(startDir);
  if (!choice) {
    console.log("Canceled.");
    return;
  }
  const next = normalize({ ...opts, workspace: choice });
  await saveConfig(stripRuntimeFields(next));
  console.log(`Workspace: ${choice}`);
  console.log("Run: lca-custom");
}

async function keysCommand() {
  for (const url of KEY_URLS) {
    if (!openUrl(url)) console.log(url);
  }
}

async function cliCommand() {
  await installCliCommand();
}

function parseSkillMeta(text, fallbackName) {
  const fm = text.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/);
  let name = fallbackName;
  let description = "";
  if (fm) {
    const block = fm[1];
    name = (block.match(/^\s*name\s*:\s*(.+?)\s*$/im)?.[1] || fallbackName).replace(/^["']|["']$/g, "").trim();
    description = (block.match(/^\s*description\s*:\s*(.+?)\s*$/im)?.[1] || "").replace(/^["']|["']$/g, "").trim();
  }
  return { name, description };
}

function listRepoSkills() {
  const skillsDir = join(REPO_ROOT, "skills");
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = join(skillsDir, entry.name, "SKILL.md");
      if (!existsSync(file)) return { folder: entry.name, name: entry.name, description: "(missing SKILL.md)" };
      const meta = parseSkillMeta(readFileSync(file, "utf8"), entry.name);
      return { folder: entry.name, ...meta };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function tuiCommand(flags = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive terminal required for lca-custom tui.");
  }
  const opts = effectiveOptions(flags);
  validate(opts, { requireWorkspace: true, requireTunnel: true });
  await ensureManagedRuntime(opts);
  const running = await runningStatusForConfig(opts);
  if (!running.health?.status || running.health.status !== "ok") {
    await start({ ...opts, background: true, skipManagedRuntime: true });
  }
  const health = await readJson(`http://127.0.0.1:${opts.port}/healthz`, 5_000);
  if (!health?.status || health.status !== "ok") {
    throw new Error(`LCA server is unavailable at http://127.0.0.1:${opts.port}/healthz`);
  }
  const tuiPath = join(SERVER_DIR, "tui.mjs");
  if (!existsSync(tuiPath)) throw new Error(`Missing TUI entrypoint: ${tuiPath}`);
  const child = spawn(opts.node, [tuiPath], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      LCA_CUSTOM_CONFIG_PATH: CONFIG_PATH,
      LCA_TUI_CONFIG_PATH: CONFIG_PATH,
      LCA_TUI_CLI_SCRIPT: fileURLToPath(import.meta.url),
      LCA_TUI_ENDPOINT: `http://127.0.0.1:${opts.port}/mcp`,
      LCA_TUI_AUTH_TOKEN: opts.authToken || "",
      LCA_TUI_WORKSPACE: opts.workspace,
      LCA_TUI_REPO_ROOT: REPO_ROOT,
      LCA_TUI_SERVER_DATA: join(SERVER_DIR, "data"),
      LCA_TUI_LAUNCHER_LOG: LOG_PATH,
      LCA_TUI_VERSION: LCA_VERSION
    },
    stdio: "inherit",
    windowsHide: false,
    shell: false
  });
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (value) => resolveExit(value ?? 1));
  });
  if (code !== 0) throw new Error(`LCA TUI exited with code ${code}`);
}

async function skillsCommand(rest) {
  const [sub = "list"] = rest;
  if (sub === "list") {
    for (const skill of listRepoSkills()) {
      console.log(`${skill.name} - ${skill.description}`);
    }
    return;
  }
  if (sub === "validate") {
    await runChecked("skills", process.execPath, [join(SCRIPT_DIR, "validate-skills.mjs")], { cwd: REPO_ROOT });
    return;
  }
  throw new Error("Usage: skills list|validate");
}

async function main() {
  const { command, rest, flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    if (command === "setup" || command === "init") return setupUsage();
    return usage();
  }
  if (command === "help") return usage();
  if (command === "run" || command === "here") return runCurrentWorkspace(flags);
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`ERROR: ${error?.message || error}`);
    process.exit(1);
  });
}
