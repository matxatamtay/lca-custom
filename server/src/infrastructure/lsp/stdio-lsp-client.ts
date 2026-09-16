import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface LspClientLike {
  start(): Promise<void>;
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: unknown): void;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
  close(): Promise<void>;
}

export interface StdioLspClientOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  requestTimeoutMs?: number;
  serverRequestHandler?: (method: string, params: unknown) => unknown | Promise<unknown>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export class StdioLspClient implements LspClientLike {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private startPromise: Promise<void> | undefined;
  private closing = false;

  constructor(private readonly options: StdioLspClientOptions) {}

  start(): Promise<void> {
    if (this.child && this.child.exitCode === null) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.spawnChild().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async request(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? 5_000): Promise<unknown> {
    await this.start();
    const child = this.requireChild();
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeMessage(child, { jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    const child = this.requireChild();
    this.writeMessage(child, { jsonrpc: "2.0", method, params });
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const child = this.child;
    if (!child) return;
    try {
      if (child.exitCode === null) {
        try { await this.request("shutdown", null, 800); } catch { /* best effort */ }
        try { this.notify("exit", null); } catch { /* best effort */ }
        await waitForExit(child, 800);
      }
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      this.rejectPending(new Error("LSP client closed."));
      this.child = undefined;
    }
  }

  private async spawnChild(): Promise<void> {
    const env = Object.fromEntries(
      Object.entries({ ...process.env, ...(this.options.env ?? {}) })
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
    const child = spawn(this.options.command, [...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", () => { /* language-server diagnostics stay local */ });
    child.once("error", (error) => this.rejectPending(error));
    child.once("exit", (code, signal) => {
      if (!this.closing) {
        this.rejectPending(new Error(`LSP process exited unexpectedly (${code ?? signal ?? "unknown"}).`));
      }
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        this.buffer = Buffer.alloc(0);
        this.rejectPending(new Error("LSP response is missing Content-Length."));
        return;
      }
      const length = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(body) as JsonRpcMessage;
      } catch {
        continue;
      }
      void this.handleMessage(message);
    }
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    if (message.method && message.id !== undefined && message.id !== null) {
      try {
        const result = await this.options.serverRequestHandler?.(message.method, message.params) ?? null;
        this.writeMessage(this.requireChild(), { jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        this.writeMessage(this.requireChild(), {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
        });
      }
      return;
    }

    if (message.method) {
      for (const listener of this.listeners) listener(message.method, message.params);
      return;
    }

    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(`LSP error ${message.error.code ?? ""}: ${message.error.message ?? "Unknown error"}`.trim()));
    } else {
      pending.resolve(message.result);
    }
  }

  private writeMessage(child: ChildProcessWithoutNullStreams, message: JsonRpcMessage): void {
    if (child.stdin.destroyed) throw new Error("LSP stdin is closed.");
    const body = JSON.stringify(message);
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private requireChild(): ChildProcessWithoutNullStreams {
    if (!this.child || this.child.exitCode !== null) throw new Error("LSP process is not running.");
    return this.child;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
    timer.unref?.();
    const onExit = () => { cleanup(); resolve(); };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}
