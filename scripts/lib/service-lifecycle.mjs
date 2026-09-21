import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export function createServiceLifecycle(options) {
  const {
    CONFIG_PATH, LOG_PATH, PID_PATH, SERVER_DIR, SERVER_SCRIPT, acquireStartLock,
    capture, chooseManagedTunnelKeeper, configId, effectiveOptions, ensureManagedRuntime,
    findManagedTunnelProcesses, inspectRuntime, installManagedRuntimeCommand, installPlan,
    isDirectory, isPidAlive, killPid, printManagedRuntimeReceipt, readJson, readPidState,
    saveConfig, spawnLogged, stopManagedServerForRepair, stopManagedTunnel, stripRuntimeFields,
    tunnelHealthArgs, validate, waitForHealth, withMutedConsoleLog, writePidState, writeTunnelProfile
  } = options;

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


  return { installCommand, start, stop, runningStatusForConfig, restartIfRunning, status, doctor };
}
