// Local Coding Agent — Coolify MCP stdio runtime
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const COOLIFY_MCP_PACKAGE = "@masonator/coolify-mcp";
export const COOLIFY_MCP_VERSION = "2.16.0";
export const DEFAULT_COOLIFY_BASE_URL = "";
const DEFAULT_TIMEOUT_MS = 120_000;

const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA"
];

function childEnvironment() {
  return Object.fromEntries(CHILD_ENV_ALLOWLIST.flatMap((key) => {
    const value = process.env[key];
    return typeof value === "string" ? [[key, value]] : [];
  }));
}

function tokenFingerprint(token) {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function retryableTransportError(error) {
  const message = String(error?.cause?.message || error?.message || error || "");
  return /closed|disconnect|connection|econn|broken pipe|transport|socket|terminated/i.test(message);
}

export function normalizeCoolifyBaseUrl(value = process.env.COOLIFY_BASE_URL || DEFAULT_COOLIFY_BASE_URL) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("COOLIFY_BASE_URL is required.");

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("COOLIFY_BASE_URL must be a valid HTTP URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("COOLIFY_BASE_URL must use http or https.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

export function resolveCoolifyMcpEntry() {
  return fileURLToPath(import.meta.resolve(COOLIFY_MCP_PACKAGE));
}

class CoolifyStdioClient {
  constructor(options) {
    this.options = options;
    this.client = undefined;
    this.connectionPromise = undefined;
    this.tools = undefined;
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
      command: process.execPath,
      args: [this.options.entry],
      env: {
        ...childEnvironment(),
        COOLIFY_BASE_URL: this.options.baseUrl,
        COOLIFY_ACCESS_TOKEN: this.options.accessToken
      },
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

  requestOptions() {
    return {
      timeout: this.options.timeoutMs,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: this.options.timeoutMs
    };
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

const coolifyClients = new Map();

function getCoolifyMcpClient(options = {}) {
  const baseUrl = normalizeCoolifyBaseUrl(options.baseUrl);
  const accessToken = String(options.accessToken ?? process.env.COOLIFY_ACCESS_TOKEN ?? "").trim();
  if (!accessToken) throw new Error("COOLIFY_ACCESS_TOKEN is required.");

  const timeoutMs = Number(options.timeoutMs ?? process.env.COOLIFY_MCP_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
    throw new Error("COOLIFY_MCP_TIMEOUT_MS must be at least 1000 milliseconds.");
  }

  const entry = String(options.entry || resolveCoolifyMcpEntry());
  const clientName = options.clientName || "local-coding-agent-coolify-bridge";
  const key = [baseUrl, tokenFingerprint(accessToken), timeoutMs, entry, clientName].join("|");

  let client = coolifyClients.get(key);
  if (!client) {
    client = new CoolifyStdioClient({
      baseUrl,
      accessToken,
      timeoutMs,
      entry,
      clientName,
      clientVersion: "2.0.0"
    });
    coolifyClients.set(key, client);
  }
  return client;
}

export async function listCoolifyMcpTools(options = {}) {
  return getCoolifyMcpClient(options).listTools({ refresh: options.refresh === true });
}

export async function callRawCoolifyMcpTool(name, args = {}, options = {}) {
  return getCoolifyMcpClient(options).callTool(name, args);
}

export async function closeCoolifyMcpClients() {
  const clients = [...coolifyClients.values()];
  coolifyClients.clear();
  await Promise.all(clients.map((client) => client.close()));
}
