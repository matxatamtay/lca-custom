// Local Coding Agent — Blender MCP stdio runtime
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const BLENDER_MCP_COMMIT = "12feeb50b49cd5e8a3152b5f9ea71fb3b4558b1d";
export const DEFAULT_BLENDER_MCP_SOURCE =
  `git+https://github.com/kleer001/blender-mcp.git@${BLENDER_MCP_COMMIT}`;
export const DEFAULT_BLENDER_MCP_HOST = "127.0.0.1";
export const DEFAULT_BLENDER_MCP_PORT = 9334;
const DEFAULT_TIMEOUT_MS = 120_000;

const CHILD_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "SHELL", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "SystemRoot", "ComSpec", "PATHEXT",
  "APPDATA", "LOCALAPPDATA"
];

function childEnvironment() {
  return Object.fromEntries(CHILD_ENV_ALLOWLIST.flatMap((key) => {
    const value = process.env[key];
    return typeof value === "string" ? [[key, value]] : [];
  }));
}

function retryableTransportError(error) {
  const message = String(error?.cause?.message || error?.message || error || "");
  return /closed|disconnect|connection|econn|broken pipe|transport|socket|terminated/i.test(message);
}

export function normalizeBlenderMcpHost(value = process.env.BLENDER_MCP_HOST || DEFAULT_BLENDER_MCP_HOST) {
  const host = String(value || DEFAULT_BLENDER_MCP_HOST).trim().toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("BLENDER_MCP_HOST must stay on loopback (127.0.0.1, localhost, or ::1).");
  }
  return host;
}

export function normalizeBlenderMcpPort(value = process.env.BLENDER_MCP_PORT || DEFAULT_BLENDER_MCP_PORT) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("BLENDER_MCP_PORT must be an integer from 1024 to 65535.");
  }
  return port;
}

export function normalizeBlenderMcpTimeout(value = process.env.BLENDER_MCP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error("BLENDER_MCP_TIMEOUT_MS must be between 1000 and 300000 milliseconds.");
  }
  return Math.round(timeoutMs);
}

class BlenderStdioClient {
  constructor(options) {
    this.options = options;
    this.client = undefined;
    this.connectionPromise = undefined;
    this.tools = undefined;
  }

  requestOptions() {
    return {
      timeout: this.options.timeoutMs,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: this.options.timeoutMs
    };
  }

  async ensureConnected() {
    if (this.client) return this.client;
    if (this.connectionPromise) return this.connectionPromise;
    this.connectionPromise = this.connect().finally(() => {
      this.connectionPromise = undefined;
    });
    return this.connectionPromise;
  }

  async connect() {
    const client = new Client({
      name: this.options.clientName,
      version: this.options.clientVersion
    });
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.args,
      env: childEnvironment(),
      stderr: "pipe"
    });
    transport.stderr?.on("data", () => undefined);
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    this.client = client;
    return client;
  }

  async listTools({ refresh = false } = {}) {
    if (this.tools && !refresh) return this.tools;
    const client = await this.ensureConnected();
    try {
      this.tools = await client.listTools({}, this.requestOptions());
      return this.tools;
    } catch (error) {
      if (!retryableTransportError(error)) throw error;
      await this.invalidate(client);
      const replacement = await this.ensureConnected();
      this.tools = await replacement.listTools({}, this.requestOptions());
      return this.tools;
    }
  }

  async callTool(name, args) {
    const client = await this.ensureConnected();
    try {
      return await client.callTool(
        { name, arguments: args || {} },
        undefined,
        this.requestOptions()
      );
    } catch (error) {
      if (!retryableTransportError(error)) throw error;
      await this.invalidate(client);
      const replacement = await this.ensureConnected();
      return replacement.callTool(
        { name, arguments: args || {} },
        undefined,
        this.requestOptions()
      );
    }
  }

  async invalidate(client) {
    if (this.client === client) {
      this.client = undefined;
      this.tools = undefined;
    }
    await client.close().catch(() => undefined);
  }

  async close() {
    const client = this.client;
    this.client = undefined;
    this.connectionPromise = undefined;
    this.tools = undefined;
    if (client) await client.close().catch(() => undefined);
  }
}

const clients = new Map();

function getBlenderMcpClient(options = {}) {
  const host = normalizeBlenderMcpHost(options.host);
  const port = normalizeBlenderMcpPort(options.port);
  const timeoutMs = normalizeBlenderMcpTimeout(options.timeoutMs);
  const source = String(options.source ?? process.env.BLENDER_MCP_SOURCE ?? DEFAULT_BLENDER_MCP_SOURCE).trim();
  const command = String(options.command ?? process.env.BLENDER_MCP_UVX_BIN ?? "uvx").trim();
  if (!source) throw new Error("BLENDER_MCP_SOURCE cannot be empty.");
  if (!command) throw new Error("BLENDER_MCP_UVX_BIN cannot be empty.");
  const args = options.args
    ? [...options.args]
    : ["--from", source, "blender-mcp", "--host", host, "--port", String(port)];
  const key = JSON.stringify([command, args, timeoutMs]);
  let client = clients.get(key);
  if (!client) {
    client = new BlenderStdioClient({
      command,
      args,
      timeoutMs,
      clientName: options.clientName || "local-coding-agent-blender-bridge",
      clientVersion: "1.0.0"
    });
    clients.set(key, client);
  }
  return client;
}

export async function listBlenderMcpTools(options = {}) {
  return getBlenderMcpClient(options).listTools({ refresh: options.refresh === true });
}

export async function callRawBlenderMcpTool(name, args = {}, options = {}) {
  return getBlenderMcpClient(options).callTool(name, args);
}

export async function closeBlenderMcpClients() {
  const values = [...clients.values()];
  clients.clear();
  await Promise.all(values.map((client) => client.close()));
}
