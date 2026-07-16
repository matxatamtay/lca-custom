#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const serverFile = path.join(root, "dist", "server", "index.mjs");
const extensionDir = path.join(root, "apps", "extension", "dist");
const dataDir = path.resolve(process.env.LBA_DATA_DIR || path.join(os.homedir(), ".local-browser-agent"));
const statePath = path.join(dataDir, "processes.json");
const logPath = path.join(dataDir, "launcher.log");
const pairingPath = path.join(dataDir, "pairing.json");
const defaultProfileDir = path.join(dataDir, "profiles");

const { command, flags } = parseArgs(process.argv.slice(2));

try {
  if (command === "start") await start(flags);
  else if (command === "stop") await stop(flags);
  else if (command === "status") await status(flags);
  else if (command === "doctor") await doctor(flags);
  else if (command === "pairing") pairing();
  else if (command === "profile") console.log(writeTunnelProfile(options(flags)));
  else if (command === "url") console.log(`http://127.0.0.1:${options(flags).port}/mcp`);
  else if (command === "build") build();
  else usage();
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function usage() {
  console.log(`Local Browser Agent CLI

Usage:
  lba start [--background] [--no-tunnel]
  lba stop
  lba status
  lba doctor
  lba pairing
  lba profile
  lba url
  lba build

Options:
  --port <port>
  --auth-token <token>
  --tunnel-bin <path>
  --tunnel-id <tunnel_...>
  --organization-id <org_...>
  --runtime-key-env <name>
  --profile <name>
  --profile-dir <path>
  --background
  --no-tunnel
`);
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "start";
  const args = command === "start" && argv[0]?.startsWith("-") ? argv : argv.slice(1);
  const flags = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const next = () => {
      if (index + 1 >= args.length) throw new Error(`Missing value for ${arg}`);
      return args[++index];
    };
    if (arg === "--background") flags.background = true;
    else if (arg === "--no-tunnel") flags.noTunnel = true;
    else if (arg === "--port") flags.port = next();
    else if (arg === "--auth-token") flags.authToken = next();
    else if (arg === "--tunnel-bin") flags.tunnelBin = next();
    else if (arg === "--tunnel-id") flags.tunnelId = next();
    else if (arg === "--organization-id") flags.organizationId = next();
    else if (arg === "--runtime-key-env") flags.runtimeKeyEnv = next();
    else if (arg === "--profile") flags.profile = next();
    else if (arg === "--profile-dir") flags.profileDir = next();
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return { command: flags.help ? "help" : command, flags };
}

function options(flags = {}) {
  const port = String(flags.port || process.env.LBA_PORT || "8790");
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error(`Invalid port: ${port}`);
  return {
    port,
    authToken: flags.authToken || process.env.LBA_MCP_AUTH_TOKEN || "",
    tunnelBin: path.resolve(flags.tunnelBin || process.env.TUNNEL_BIN || path.join(root, "tools", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client")),
    tunnelId: flags.tunnelId || process.env.CONTROL_PLANE_TUNNEL_ID || "",
    organizationId: flags.organizationId || process.env.OPENAI_ORGANIZATION || process.env.OPENAI_ORG_ID || "",
    runtimeKeyEnv: flags.runtimeKeyEnv || "CONTROL_PLANE_API_KEY",
    profile: flags.profile || "local-browser-agent",
    profileDir: path.resolve(flags.profileDir || process.env.TUNNEL_PROFILE_DIR || defaultProfileDir),
    background: Boolean(flags.background),
    noTunnel: Boolean(flags.noTunnel)
  };
}

async function start(flags) {
  const opts = options(flags);
  if (!existsSync(serverFile) || !existsSync(path.join(extensionDir, "manifest.json"))) build();
  mkdirSync(dataDir, { recursive: true });

  const state = readState();
  let health = await readJson(`http://127.0.0.1:${opts.port}/healthz`);
  let serverChild = null;
  if (!health?.status) {
    const stdio = opts.background ? backgroundStdio() : "inherit";
    serverChild = spawn(process.execPath, [serverFile], {
      cwd: root,
      env: { ...process.env, LBA_PORT: opts.port, LBA_MCP_AUTH_TOKEN: opts.authToken },
      detached: opts.background,
      stdio
    });
    if (opts.background) serverChild.unref();
    health = await waitForHealth(opts.port);
    if (!health) throw new Error(`Server did not become healthy on port ${opts.port}. See ${logPath}`);
    state.serverPid = health.pid || serverChild.pid;
  } else {
    state.serverPid = health.pid;
  }

  console.log(`[server] MCP: http://127.0.0.1:${opts.port}/mcp`);
  console.log(`[extension] Load unpacked: ${extensionDir}`);
  printPairing();

  let tunnelChild = null;
  const useTunnel = !opts.noTunnel && Boolean(opts.tunnelId);
  if (useTunnel) {
    if (!existsSync(opts.tunnelBin)) throw new Error(`Tunnel client not found: ${opts.tunnelBin}`);
    const runtimeKey = process.env[opts.runtimeKeyEnv];
    if (!runtimeKey) throw new Error(`Missing runtime API key in ${opts.runtimeKeyEnv}.`);
    const profilePath = writeTunnelProfile(opts);
    const env = { ...process.env, CONTROL_PLANE_API_KEY: runtimeKey, CONTROL_PLANE_TUNNEL_ID: opts.tunnelId };
    if (opts.authToken) {
      env.MCP_AUTH_HEADER = `Bearer ${opts.authToken}`;
      env.MCP_EXTRA_HEADERS = "Authorization: env:MCP_AUTH_HEADER";
    }
    const stdio = opts.background ? backgroundStdio() : "inherit";
    tunnelChild = spawn(opts.tunnelBin, [
      "run",
      "--profile", opts.profile,
      "--profile-dir", opts.profileDir,
      "--control-plane.tunnel-id", opts.tunnelId,
      ...tunnelHealthArgs()
    ], { cwd: path.dirname(opts.tunnelBin), env, detached: opts.background, stdio });
    if (opts.background) tunnelChild.unref();
    state.tunnelPid = tunnelChild.pid;
    console.log(`[tunnel] Profile: ${profilePath}`);
  } else {
    delete state.tunnelPid;
    console.log("[tunnel] Local-only mode. Set CONTROL_PLANE_TUNNEL_ID and CONTROL_PLANE_API_KEY to enable the secure tunnel.");
  }

  state.port = opts.port;
  state.updatedAt = new Date().toISOString();
  writeState(state);
  if (opts.background) {
    console.log(`[background] Logs: ${logPath}`);
    return;
  }

  const stopChildren = () => {
    if (tunnelChild?.pid) killPid(tunnelChild.pid);
    if (serverChild?.pid) killPid(serverChild.pid);
  };
  process.on("SIGINT", () => { stopChildren(); process.exit(130); });
  process.on("SIGTERM", () => { stopChildren(); process.exit(143); });
  if (tunnelChild) await new Promise((resolve) => tunnelChild.once("exit", resolve));
  else if (serverChild) await new Promise((resolve) => serverChild.once("exit", resolve));
}

async function stop(flags) {
  const opts = options(flags);
  const state = readState();
  const health = await readJson(`http://127.0.0.1:${opts.port}/healthz`);
  const pids = [state.tunnelPid, health?.pid || state.serverPid].filter(Boolean);
  for (const pid of pids) killPid(Number(pid));
  rmSync(statePath, { force: true });
  console.log(pids.length ? `Stopped ${pids.length} process(es).` : "No running Local Browser Agent process found.");
}

async function status(flags) {
  const opts = options(flags);
  const state = readState();
  const health = await readJson(`http://127.0.0.1:${opts.port}/healthz`);
  console.log(JSON.stringify({
    server: health || { status: "offline", port: opts.port },
    state,
    extensionDir,
    logPath
  }, null, 2));
}

async function doctor(flags) {
  const opts = options(flags);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add("node", Number(process.versions.node.split(".")[0]) >= 20, process.version);
  add("server build", existsSync(serverFile), serverFile);
  add("extension build", existsSync(path.join(extensionDir, "manifest.json")), extensionDir);
  add("data directory", existsSync(dataDir), dataDir);
  const health = await readJson(`http://127.0.0.1:${opts.port}/healthz`);
  add("server health", health?.status === "ok", health?.status || "offline");
  if (opts.tunnelId) add("tunnel client", existsSync(opts.tunnelBin), opts.tunnelBin);
  for (const check of checks) console.log(`${check.ok ? "PASS" : "WARN"}  ${check.name}: ${check.detail}`);
  if (checks.some((check) => !check.ok && ["node", "server build", "extension build"].includes(check.name))) process.exitCode = 1;
}

function pairing() {
  const value = readPairing(true);
  console.log(`Pairing code: ${value.code}`);
  console.log(`Expires: ${value.expiresAt}`);
}

function printPairing() {
  const value = readPairing(false);
  if (value) console.log(`[pairing] ${value.code} (expires ${value.expiresAt})`);
  else console.log(`[pairing] Run 'lba pairing' after the server finishes starting.`);
}

function readPairing(required) {
  try {
    return JSON.parse(readFileSync(pairingPath, "utf8"));
  } catch {
    if (required) throw new Error("Pairing code is unavailable. Start the server first.");
    return null;
  }
}

function build() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["run", "build"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error("Build failed.");
}

function writeTunnelProfile(opts) {
  if (!opts.tunnelId) throw new Error("Missing tunnel id.");
  mkdirSync(opts.profileDir, { recursive: true });
  const fileName = opts.profile.endsWith(".yaml") ? opts.profile : `${opts.profile}.yaml`;
  const profilePath = path.join(opts.profileDir, fileName);
  const lines = [
    "config_version: 1",
    "control_plane:",
    '  base_url: "https://api.openai.com"',
    `  tunnel_id: "${yamlEscape(opts.tunnelId)}"`,
    '  api_key: "env:CONTROL_PLANE_API_KEY"'
  ];
  if (opts.organizationId) {
    lines.push("  extra_headers:");
    lines.push(`    - "OpenAI-Organization: ${yamlEscape(opts.organizationId)}"`);
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
  writeFileSync(profilePath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  return profilePath;
}

function yamlEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "");
}

function tunnelHealthArgs() {
  if (process.platform === "win32") return ["--health.listen-addr", "127.0.0.1:0"];
  const socketPath = path.join(os.tmpdir(), `lba-tunnel-${process.pid}.sock`);
  rmSync(socketPath, { force: true });
  return ["--health.unix-socket", socketPath];
}

function backgroundStdio() {
  mkdirSync(dataDir, { recursive: true });
  const fd = openSync(logPath, "a", 0o600);
  return ["ignore", fd, fd];
}

function readState() {
  try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return {}; }
}

function writeState(value) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(pid, "SIGTERM");
  } catch {}
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const health = await readJson(`http://127.0.0.1:${port}/healthz`);
    if (health?.status === "ok") return health;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function readJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
