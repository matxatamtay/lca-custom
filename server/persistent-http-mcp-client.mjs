// Local Coding Agent — persistent Streamable HTTP MCP client
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export class PersistentHttpMcpClient {
  constructor(options) {
    this.endpoint = String(options.endpoint);
    this.clientName = String(options.clientName || "local-coding-agent-http-bridge");
    this.clientVersion = String(options.clientVersion || "1.0.0");
    this.timeoutMs = normalizeTimeout(options.timeoutMs, 30_000);
    this.requestInit = options.requestInit;
    this.mapError = typeof options.mapError === "function" ? options.mapError : defaultErrorMapper;
    this.connectionFactory = options.connectionFactory || (() => createHttpConnection({
      endpoint: this.endpoint,
      clientName: this.clientName,
      clientVersion: this.clientVersion,
      requestInit: this.requestInit,
      timeoutMs: this.timeoutMs
    }));
    this.connection = undefined;
    this.connectionPromise = undefined;
    this.toolsResult = undefined;
    this.toolsPromise = undefined;
    this.epoch = 0;
  }

  async listTools(options = {}) {
    const refresh = options?.refresh === true;
    if (!refresh && this.toolsResult) return this.toolsResult;
    if (!refresh && this.toolsPromise) return this.toolsPromise;

    const pending = this.request(
      (connection) => connection.listTools(),
      "MCP tools/list",
      true
    ).then((result) => {
      this.toolsResult = result;
      return result;
    }).finally(() => {
      if (this.toolsPromise === pending) this.toolsPromise = undefined;
    });

    this.toolsPromise = pending;
    return pending;
  }

  async callTool(input) {
    const name = String(input?.name || "").trim();
    if (!name) throw this.mapError(new Error("MCP tool name is required."));
    return this.request(
      (connection) => connection.callTool({ name, arguments: input?.arguments || {} }),
      `MCP tool ${name}`,
      true
    );
  }

  async findTool(name, options = {}) {
    const toolName = String(name || "").trim();
    let listed = await this.listTools();
    let tool = listed.tools?.find((candidate) => candidate.name === toolName);
    if (!tool && options.refreshIfMissing !== false) {
      listed = await this.listTools({ refresh: true });
      tool = listed.tools?.find((candidate) => candidate.name === toolName);
    }
    return { listed, tool };
  }

  async close() {
    this.epoch += 1;
    const current = this.connection;
    const pending = this.connectionPromise;
    this.connection = undefined;
    this.connectionPromise = undefined;
    this.clearToolsCache();

    const pendingConnection = pending ? await pending.catch(() => undefined) : undefined;
    const connections = new Set([current, pendingConnection].filter(Boolean));
    await Promise.all([...connections].map((connection) => connection.close().catch(() => undefined)));
  }

  async request(operation, label, allowRetry) {
    let connection;
    try {
      connection = await this.ensureConnection();
      return await withTimeout(Promise.resolve(operation(connection)), this.timeoutMs, label);
    } catch (error) {
      if (allowRetry && connection && isRetryableTransportError(error)) {
        await this.invalidate(connection);
        try {
          const replacement = await this.ensureConnection();
          return await withTimeout(Promise.resolve(operation(replacement)), this.timeoutMs, label);
        } catch (retryError) {
          throw this.mapError(retryError);
        }
      }
      throw this.mapError(error);
    }
  }

  async ensureConnection() {
    if (this.connection) return this.connection;
    if (this.connectionPromise) return this.connectionPromise;

    const epoch = this.epoch;
    const pending = Promise.resolve()
      .then(() => this.connectionFactory())
      .then(async (connection) => {
        if (epoch !== this.epoch) {
          await connection.close().catch(() => undefined);
          throw new Error("MCP client was closed while connecting.");
        }
        this.connection = connection;
        return connection;
      })
      .finally(() => {
        if (this.connectionPromise === pending) this.connectionPromise = undefined;
      });

    this.connectionPromise = pending;
    return pending;
  }

  async invalidate(connection) {
    if (this.connection === connection) this.connection = undefined;
    this.clearToolsCache();
    await connection.close().catch(() => undefined);
  }

  clearToolsCache() {
    this.toolsResult = undefined;
    this.toolsPromise = undefined;
  }
}

export class PersistentHttpMcpClientRegistry {
  constructor() {
    this.clients = new Map();
  }

  get(key, factory) {
    const normalizedKey = String(key);
    let client = this.clients.get(normalizedKey);
    if (!client) {
      client = factory();
      this.clients.set(normalizedKey, client);
    }
    return client;
  }

  async closeAll() {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  }

  get size() {
    return this.clients.size;
  }
}

export function persistentHttpClientKey({ endpoint, authToken = "", clientName = "" }) {
  const credentialHash = authToken
    ? createHash("sha256").update(String(authToken)).digest("hex").slice(0, 16)
    : "none";
  return JSON.stringify({ endpoint: String(endpoint), credentialHash, clientName: String(clientName) });
}

export function normalizeTimeout(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(300_000, Math.max(1_000, Math.trunc(parsed)));
}

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function isRetryableTransportError(error) {
  const message = String(error?.cause?.message || error?.message || error || "");
  return /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed|Failed to open SSE stream|transport(?:\s+connection)?\s+closed|connection\s+(?:was\s+)?closed|disconnected|timed out/i.test(message);
}

async function createHttpConnection(options) {
  const client = new Client({ name: options.clientName, version: options.clientVersion });
  const transportOptions = options.requestInit ? { requestInit: options.requestInit } : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(options.endpoint), transportOptions);
  try {
    await withTimeout(client.connect(transport), options.timeoutMs, "Connecting to MCP server");
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  return {
    listTools: () => client.listTools(),
    callTool: (input) => client.callTool(input),
    close: () => client.close()
  };
}

function defaultErrorMapper(error) {
  return error instanceof Error ? error : new Error(String(error));
}
