// Local Coding Agent TUI — launcher subprocess bridge
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import path from "node:path";

export class LauncherBridge {
  constructor(options = {}) {
    this.node = options.node || process.execPath;
    this.scriptPath = path.resolve(options.scriptPath);
    this.cwd = path.resolve(options.cwd || path.dirname(this.scriptPath));
    this.configPath = options.configPath ? path.resolve(options.configPath) : "";
    this.env = { ...process.env, ...(options.env || {}) };
    if (this.configPath) this.env.LCA_CUSTOM_CONFIG_PATH = this.configPath;
  }

  run(args, options = {}) {
    return capture(this.node, [this.scriptPath, ...args], {
      cwd: this.cwd,
      env: this.env,
      timeoutMs: options.timeoutMs || 300_000
    });
  }

  async json(args, options = {}) {
    const result = await this.run([...args, "--json"], options);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || `lca-custom ${args.join(" ")} failed`);
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`Invalid JSON from lca-custom ${args.join(" ")}: ${error.message}`);
    }
  }

  status() { return this.json(["status"]); }
  doctor() { return this.json(["doctor"], { timeoutMs: 300_000 }); }
  start() { return this.run(["start", "--background"], { timeoutMs: 600_000 }); }
  stop() { return this.run(["stop"], { timeoutMs: 60_000 }); }
  addProject(project) { return this.run(["add", project], { timeoutMs: 600_000 }); }
  removeProject(project) { return this.run(["remove", project], { timeoutMs: 600_000 }); }
  resetProjects(project) { return this.run(["reset", project], { timeoutMs: 600_000 }); }
  setPrimaryProject(project) { return this.run(["primary", project], { timeoutMs: 600_000 }); }
  memoryStatus() { return this.json(["memory", "status"], { timeoutMs: 120_000 }); }
  memoryExport(file) { return this.json(["memory", "export", file], { timeoutMs: 600_000 }); }
  memoryImport(file, options = {}) {
    const args = ["memory", "import", file, "--strategy", options.strategy || "skip"];
    if (options.dryRun) args.push("--dry-run");
    if (options.force) args.push("--force");
    return this.json(args, { timeoutMs: 600_000 });
  }
}

export function launcherInvocation(scriptPath, args, configPath = "") {
  return {
    command: process.execPath,
    args: [path.resolve(scriptPath), ...args],
    env: configPath ? { LCA_CUSTOM_CONFIG_PATH: path.resolve(configPath) } : {}
  };
}

function capture(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      if (settled) return;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    }, options.timeoutMs || 300_000);
    timer.unref?.();
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, signal: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}
