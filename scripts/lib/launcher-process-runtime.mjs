import { spawn } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export function createLauncherProcessRuntime(options) {
  const {
    LOG_PATH, PID_PATH, START_LOCK_OWNER_PATH, START_LOCK_PATH, capture, ensureConfigDir,
    readJsonFile, yamlEscape
  } = options;

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

  function isManagedTunnelArgv(argv, opts = {}) {
    if (!Array.isArray(argv) || argv.length < 2 || !samePath(argv[0], opts.tunnelBin)) return false;
    if (argv[1] !== "run") return false;
    if (argvOptionValue(argv, "--profile") !== String(opts.profile || "")) return false;
    if (!samePath(argvOptionValue(argv, "--profile-dir"), opts.profileDir)) return false;
    const expectedTunnelId = String(opts.tunnelId || "");
    return !expectedTunnelId || argvOptionValue(argv, "--control-plane.tunnel-id") === expectedTunnelId;
  }

  function chooseManagedTunnelKeeper(processes, state = {}, current = {}) {
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


  return {
    acquireStartLock, appendLog, chooseManagedTunnelKeeper, findManagedTunnelProcesses,
    isManagedTunnelArgv, isPidAlive, killPid, readJson, readPidState, spawnLogged,
    stopManagedTunnel, tunnelHealthArgs, waitForHealth, writePidState, writeTunnelProfile
  };
}
