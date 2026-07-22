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
      if (await this.options.probe.isReady()) return;
      await this.sleep(this.retryDelayMs);
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
    return this.memory.recall(request);
  }
}

export interface HttpAgentMemoryHealthProbeOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class HttpAgentMemoryHealthProbe implements AgentMemoryHealthProbe {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpAgentMemoryHealthProbeOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:3111").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 1_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async isReady(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/agentmemory/livez`, {
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!response.ok) return false;
      const body = await response.json() as { status?: unknown };
      return body.status === "ok";
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
}

export class AgentMemoryCliController implements AgentMemoryRuntimeController {
  private child: ChildProcess | undefined;
  private ownsRuntime = false;
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
    await this.ensureInstalled();
    await this.ensureInitialized();
    await this.recoverOrphanEngine();

    const child = spawn(process.execPath, [this.cliPath], {
      cwd: this.runtimeDirectory,
      env: {
        ...process.env,
        CI: "1",
        AGENTMEMORY_USE_DOCKER: this.options.useDocker === false ? "0" : "1",
        ...(this.options.env ?? {})
      },
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"]
    });
    this.child = child;
    this.ownsRuntime = true;
    child.once("exit", () => {
      if (this.child === child) this.child = undefined;
    });
  }

  async close(): Promise<void> {
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
      env: {
        ...process.env,
        CI: "1",
        AGENTMEMORY_USE_DOCKER: this.options.useDocker === false ? "0" : "1",
        ...(this.options.env ?? {})
      },
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    });
  }
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
