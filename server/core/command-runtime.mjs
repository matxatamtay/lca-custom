import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export function createCommandRuntime(options) {
  const {
    MAX_COMMAND_OUTPUT, PRIMARY_ROOT, PROC_BUFFER, appendLimited, hasCommand, isoNow, processes
  } = options;

  function defaultShell() {
    if (process.platform === "win32") return "cmd";
    return hasCommand("bash") ? "bash" : "sh";
  }

  function buildSpawn(command, shell) {
    const s = shell || defaultShell();
    if (s === "powershell") {
      const file = process.platform === "win32" ? "powershell.exe" : hasCommand("pwsh") ? "pwsh" : "powershell";
      return { file, args: ["-NoProfile", "-NonInteractive", "-Command", command], opts: {} };
    }
    if (s === "bash") {
      return { file: "bash", args: ["-lc", command], opts: {} };
    }
    if (s === "sh") {
      return { file: "sh", args: ["-c", command], opts: {} };
    }
    if (s === "zsh") {
      return { file: "zsh", args: ["-lc", command], opts: {} };
    }
    // cmd / default: rely on the OS shell so pipes/redirects work.
    return { file: command, args: [], opts: { shell: true } };
  }

  function spawnOptions(cwd, opts = {}, env) {
    return {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      ...(env ? { env } : {}),
      ...opts
    };
  }

  function terminateChildTree(child, signal = "SIGTERM") {
    if (!child?.pid) return;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        process.kill(-child.pid, signal);
      }
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
  }

  function runShellCommand(command, cwd, shell, timeoutMs) {
    const { file, args, opts } = buildSpawn(command, shell);
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let child;
      try {
        child = spawn(file, args, spawnOptions(cwd, opts, { ...process.env, AGENT_WORKSPACE: PRIMARY_ROOT }));
      } catch (err) {
        resolve({ exit_code: null, timed_out: false, stdout: "", stderr: String(err?.message || err) });
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        terminateChildTree(child, "SIGTERM");
      }, timeoutMs);
      child.stdout?.on("data", (c) => (stdout = appendLimited(stdout, c.toString(), MAX_COMMAND_OUTPUT)));
      child.stderr?.on("data", (c) => (stderr = appendLimited(stderr, c.toString(), MAX_COMMAND_OUTPUT)));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ exit_code: null, timed_out: timedOut, stdout, stderr: stderr + String(err?.message || err) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exit_code: code, timed_out: timedOut, stdout, stderr });
      });
    });
  }

  function spawnCapture(file, args, cwd, timeoutMs) {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let child;
      try {
        child = spawn(file, args, spawnOptions(cwd));
      } catch (err) {
        resolve({ exit_code: null, timed_out: false, stdout: "", stderr: String(err?.message || err) });
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        terminateChildTree(child, "SIGTERM");
      }, timeoutMs);
      child.stdout?.on("data", (c) => (stdout = appendLimited(stdout, c.toString(), MAX_COMMAND_OUTPUT)));
      child.stderr?.on("data", (c) => (stderr = appendLimited(stderr, c.toString(), MAX_COMMAND_OUTPUT)));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ exit_code: null, timed_out: timedOut, stdout, stderr: stderr + String(err?.message || err) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exit_code: code, timed_out: timedOut, stdout, stderr });
      });
    });
  }

  function startBackground(command, cwd, shell, name) {
    const { file, args, opts } = buildSpawn(command, shell);
    const child = spawn(file, args, spawnOptions(cwd, opts, { ...process.env, AGENT_WORKSPACE: PRIMARY_ROOT }));
    const proc = {
      id: randomUUID(),
      name: name || command.slice(0, 40),
      command,
      child,
      status: "running",
      exitCode: null,
      startedAt: isoNow(),
      stdout: "",
      stderr: ""
    };
    child.stdout?.on("data", (c) => (proc.stdout = appendLimited(proc.stdout, c.toString(), PROC_BUFFER)));
    child.stderr?.on("data", (c) => (proc.stderr = appendLimited(proc.stderr, c.toString(), PROC_BUFFER)));
    child.on("error", (err) => {
      proc.status = "error";
      proc.stderr = appendLimited(proc.stderr, String(err?.message || err), PROC_BUFFER);
    });
    child.on("close", (code) => {
      proc.status = "exited";
      proc.exitCode = code;
    });
    processes.set(proc.id, proc);
    return proc;
  }

  function killProcessTree(proc) {
    if (!proc?.child || proc.status !== "running") {
      if (proc) proc.status = proc.status === "running" ? "stopped" : proc.status;
      return;
    }
    const pid = proc.child.pid;
    try {
      if (pid) terminateChildTree(proc.child, "SIGTERM");
    } catch {}
    proc.status = "stopped";
  }


  return { defaultShell, killProcessTree, runShellCommand, spawnCapture, startBackground };
}
