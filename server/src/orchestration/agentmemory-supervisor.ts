import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ContextEvidence, TaskContextRequest } from "../domain/task-context.js";
import type { MemoryPort } from "../ports/context-providers.js";

const execFileAsync = promisify(execFile);

export interface AgentMemoryHealthProbe {
  isReady(): Promise<boolean>;
}

export interface AgentMemoryRuntimeController {
  start(): Promise<void>;
  close(): Promise<void>;
  startupFailure?(): Error | undefined;
}

export interface AgentMemorySupervisorOptions {
  probe: AgentMemoryHealthProbe;
  runtime: AgentMemoryRuntimeController;
  attempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class AgentMemorySupervisor {
  private ensurePromise: Promise<void> | undefined;
  private readonly attempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: AgentMemorySupervisorOptions) {
    this.attempts = options.attempts ?? 100;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async ensureReady(): Promise<void> {
    if (await this.options.probe.isReady()) return;
    if (this.ensurePromise) return this.ensurePromise;

    this.ensurePromise = this.startAndWait().finally(() => {
      this.ensurePromise = undefined;
    });
    return this.ensurePromise;
  }

  close(): Promise<void> {
    return this.options.runtime.close();
  }

  private async startAndWait(): Promise<void> {
    await this.options.runtime.start();
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const startupFailure = this.options.runtime.startupFailure?.();
      if (startupFailure) {
        throw new Error(`AgentMemory failed during automatic startup: ${startupFailure.message}`, {
          cause: startupFailure
        });
      }
      if (await this.options.probe.isReady()) return;
      if (attempt + 1 < this.attempts) await this.sleep(this.retryDelayMs);
    }
    const startupFailure = this.options.runtime.startupFailure?.();
    if (startupFailure) {
      throw new Error(`AgentMemory failed during automatic startup: ${startupFailure.message}`, {
        cause: startupFailure
      });
    }
    throw new Error("AgentMemory did not become ready after an automatic start attempt.");
  }
}

export class SupervisedMemoryPort implements MemoryPort {
  constructor(
    private readonly supervisor: AgentMemorySupervisor,
    private readonly memory: MemoryPort
  ) {}

  async recall(request: TaskContextRequest): Promise<readonly ContextEvidence[]> {
    await this.supervisor.ensureReady();
    try {
      return await this.memory.recall(request);
    } catch (error) {
      if (!isRetryableAgentMemoryRecallError(error)) throw error;
      await this.supervisor.ensureReady();
      return this.memory.recall(request);
    }
  }
}

function isRetryableAgentMemoryRecallError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = `${error.name}: ${error.message}`.toLowerCase();
  const code = String((error as Error & { code?: unknown; cause?: { code?: unknown } }).code
    ?? (error as Error & { cause?: { code?: unknown } }).cause?.code
    ?? "").toLowerCase();
  return message.includes("fetch failed")
    || message.includes("network")
    || message.includes("socket hang up")
    || message.includes("connection reset")
    || message.includes("connection refused")
    || ["econnrefused", "econnreset", "etimedout", "und_err_connect_timeout", "und_err_socket"].includes(code);
}

export interface HttpAgentMemoryHealthProbeOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  secret?: string;
}

export class HttpAgentMemoryHealthProbe implements AgentMemoryHealthProbe {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly secret: string | undefined;

  constructor(options: HttpAgentMemoryHealthProbeOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:3111").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 1_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.secret = options.secret;
  }

  async isReady(): Promise<boolean> {
    try {
      const headers = new Headers({ Accept: "application/json" });
      if (this.secret) headers.set("Authorization", `Bearer ${this.secret}`);
      const response = await this.fetchImpl(`${this.baseUrl}/agentmemory/diagnostics/followup`, {
        headers,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export interface AgentMemoryCliControllerOptions {
  runtimeDirectory: string;
  useDocker?: boolean;
  env?: Readonly<Record<string, string>>;
  enginePort?: number;
  installIfMissing?: boolean;
  prepareRuntime?: (runtimeDirectory: string) => Promise<void>;
}

export class AgentMemoryCliController implements AgentMemoryRuntimeController {
  private child: ChildProcess | undefined;
  private ownsRuntime = false;
  private closing = false;
  private startupFailureValue: Error | undefined;
  private stdoutTail = "";
  private stderrTail = "";
  private readonly cliPath: string;
  private readonly runtimeDirectory: string;
  private readonly enginePort: number;

  constructor(private readonly options: AgentMemoryCliControllerOptions) {
    this.runtimeDirectory = path.resolve(options.runtimeDirectory);
    this.enginePort = options.enginePort ?? 49_134;
    this.cliPath = path.join(
      this.runtimeDirectory,
      "node_modules",
      "@agentmemory",
      "agentmemory",
      "dist",
      "cli.mjs"
    );
  }

  async start(): Promise<void> {
    if (this.child && this.child.exitCode === null && !this.child.killed) return;
    this.startupFailureValue = undefined;
    this.stdoutTail = "";
    this.stderrTail = "";
    this.closing = false;
    await this.ensureInstalled();
    await this.options.prepareRuntime?.(this.runtimeDirectory);
    await this.ensureInitialized();
    await this.recoverOrphanEngine();

    const child = spawn(process.execPath, [this.cliPath], {
      cwd: this.runtimeDirectory,
      env: this.runtimeEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;
    this.ownsRuntime = true;
    child.stdout?.on("data", (chunk: Buffer | string) => {
      this.stdoutTail = appendOutputTail(this.stdoutTail, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderrTail = appendOutputTail(this.stderrTail, chunk);
    });
    child.once("error", (error) => {
      if (!this.closing) this.startupFailureValue = error;
      if (this.child === child) this.child = undefined;
    });
    child.once("exit", (code, signal) => {
      if (!this.closing) {
        this.startupFailureValue = new Error(this.formatProcessExit(code, signal));
      }
      if (this.child === child) this.child = undefined;
    });
  }

  startupFailure(): Error | undefined {
    return this.startupFailureValue;
  }

  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      await waitForChildExit(child, 5_000);
    }
    if (!this.ownsRuntime) return;
    this.ownsRuntime = false;
    await this.stopRuntime().catch(() => undefined);
  }

  private runtimeEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CI: "1",
      ...(this.options.env ?? {})
    };
    if (this.options.useDocker !== undefined) {
      environment.AGENTMEMORY_USE_DOCKER = this.options.useDocker ? "1" : "0";
    }
    return environment;
  }

  private formatProcessExit(code: number | null, signal: NodeJS.Signals | null): string {
    const reason = signal
      ? `was terminated by ${signal}`
      : `exited with code ${code ?? "unknown"}`;
    const diagnostics = [
      this.stderrTail.trim() ? `stderr:\n${this.stderrTail.trim()}` : "",
      this.stdoutTail.trim() ? `stdout:\n${this.stdoutTail.trim()}` : ""
    ].filter(Boolean).join("\n");
    return diagnostics
      ? `AgentMemory process ${reason}.\n${diagnostics}`
      : `AgentMemory process ${reason} without producing diagnostic output.`;
  }

  private async ensureInstalled(): Promise<void> {
    try {
      await access(this.cliPath);
      return;
    } catch {}
    if (this.options.installIfMissing === false) {
      throw new Error(`AgentMemory runtime is not installed at ${this.runtimeDirectory}.`);
    }

    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    await execFileAsync(npm, ["ci", "--ignore-scripts"], {
      cwd: this.runtimeDirectory,
      env: { ...process.env, ...(this.options.env ?? {}) },
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    });
    await access(this.cliPath);
  }

  private async ensureInitialized(): Promise<void> {
    const envPath = path.join(os.homedir(), ".agentmemory", ".env");
    try {
      await access(envPath);
      return;
    } catch {}

    await execFileAsync(process.execPath, [this.cliPath, "init"], {
      cwd: this.runtimeDirectory,
      env: { ...process.env, CI: "1", ...(this.options.env ?? {}) },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
  }

  private async recoverOrphanEngine(): Promise<void> {
    if (!await isTcpPortOpen(this.enginePort)) return;
    if (!await this.isOwnedEngine()) {
      throw new Error(
        `AgentMemory engine port ${this.enginePort} is occupied by a runtime not owned by LCA. Refusing to stop it.`
      );
    }
    await this.stopRuntime();
  }

  private async isOwnedEngine(): Promise<boolean> {
    const statePath = path.join(os.homedir(), ".agentmemory", "engine-state.json");
    try {
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        kind?: unknown;
        composeFile?: unknown;
        binPath?: unknown;
      };
      if (state.kind === "docker" && typeof state.composeFile === "string") {
        return isWithin(this.runtimeDirectory, state.composeFile);
      }
      if (state.kind === "native" && typeof state.binPath === "string") {
        return isWithin(path.join(os.homedir(), ".agentmemory"), state.binPath);
      }
      return false;
    } catch {
      return false;
    }
  }

  private async stopRuntime(): Promise<void> {
    await execFileAsync(process.execPath, [this.cliPath, "stop", "--force"], {
      cwd: this.runtimeDirectory,
      env: this.runtimeEnvironment(),
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    });
  }
}

const MAX_PROCESS_OUTPUT_CHARS = 16 * 1024;

function appendOutputTail(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length <= MAX_PROCESS_OUTPUT_CHARS
    ? next
    : next.slice(next.length - MAX_PROCESS_OUTPUT_CHARS);
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isTcpPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}


function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.removeListener("exit", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    child.once("exit", done);
  });
}
