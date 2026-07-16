import { randomUUID } from "node:crypto";
import type http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { COMMAND_TIMEOUT_MS, MAX_BRIDGE_PAYLOAD_BYTES, VERSION } from "../config.js";
import { audit } from "../security/audit.js";
import { PairingManager } from "../security/pairing.js";
import {
  BridgeClientMessageSchema,
  type BridgeClientMessage,
  type BridgeServerMessage,
  PROTOCOL_VERSION
} from "../../../../packages/protocol/src/index.js";

interface Connection {
  socket: WebSocket;
  origin: string;
  extensionId?: string;
  sessionId?: string;
  authenticated: boolean;
  capabilities: string[];
  connectedAt: string;
  lastSeenAt: string;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  chunks: Map<string, string[]>;
}

export class BridgeServer {
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BRIDGE_PAYLOAD_BYTES });
  readonly #connections = new Set<Connection>();
  readonly #pending = new Map<string, PendingCommand>();

  constructor(readonly pairing: PairingManager) {
    this.#wss.on("connection", (socket, request) => this.#onConnection(socket, String(request.headers.origin || "")));
  }

  handleUpgrade(request: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    const origin = String(request.headers.origin || "");
    if (url.pathname !== "/bridge" || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    this.#wss.handleUpgrade(request, socket, head, (ws) => this.#wss.emit("connection", ws, request));
  }

  status(): Record<string, unknown> {
    const active = [...this.#connections].filter((connection) => connection.authenticated && connection.socket.readyState === WebSocket.OPEN);
    return {
      connected: active.length > 0,
      connections: active.map((connection) => ({
        sessionId: connection.sessionId,
        extensionId: connection.extensionId,
        capabilities: connection.capabilities,
        connectedAt: connection.connectedAt,
        lastSeenAt: connection.lastSeenAt
      }))
    };
  }

  async sendCommand(command: "status" | "listTabs" | "capture" | "navigate" | "interact" | "cancel", args: unknown = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<unknown> {
    const connection = [...this.#connections].find((candidate) => candidate.authenticated && candidate.socket.readyState === WebSocket.OPEN);
    if (!connection) throw new Error("No authenticated Chromium extension is connected.");
    const requestId = randomUUID();
    const message: BridgeServerMessage = { type: "command", requestId, command, args };

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`Browser command timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(requestId, { resolve, reject, timer, chunks: new Map() });
      try {
        connection.socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    for (const connection of this.#connections) connection.socket.close(1001, "Server shutting down");
    this.#wss.close();
  }

  #onConnection(socket: WebSocket, origin: string): void {
    const now = new Date().toISOString();
    const connection: Connection = {
      socket,
      origin,
      authenticated: false,
      capabilities: [],
      connectedAt: now,
      lastSeenAt: now
    };
    this.#connections.add(connection);
    this.#send(connection, {
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      authenticated: false,
      pairingRequired: true,
      serverVersion: VERSION
    });

    socket.on("message", (raw) => this.#onMessage(connection, raw.toString()));
    socket.on("close", () => {
      this.#connections.delete(connection);
      void audit({ action: "bridge_disconnect", extensionId: connection.extensionId, sessionId: connection.sessionId });
    });
    socket.on("error", () => {});
  }

  #onMessage(connection: Connection, raw: string): void {
    connection.lastSeenAt = new Date().toISOString();
    let message: BridgeClientMessage;
    try {
      message = BridgeClientMessageSchema.parse(JSON.parse(raw));
    } catch (error) {
      this.#send(connection, { type: "error", code: "invalid_message", message: error instanceof Error ? error.message : "Invalid message." });
      return;
    }

    if (message.type === "hello") {
      connection.extensionId = message.extensionId;
      connection.capabilities = message.capabilities;
      const authenticated = message.token
        ? this.pairing.authenticate(message.token, message.extensionId, connection.origin)
        : null;
      connection.authenticated = Boolean(authenticated);
      connection.sessionId = authenticated?.sessionId;
      this.#send(connection, {
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        authenticated: connection.authenticated,
        pairingRequired: !connection.authenticated,
        serverVersion: VERSION,
        sessionId: connection.sessionId
      });
      void audit({ action: "bridge_hello", ok: connection.authenticated, extensionId: message.extensionId, capabilities: message.capabilities });
      return;
    }

    if (message.type === "pair") {
      try {
        if (connection.extensionId && connection.extensionId !== message.extensionId) throw new Error("Extension id changed during pairing.");
        const paired = this.pairing.pair(message.code, message.extensionId, connection.origin);
        connection.extensionId = message.extensionId;
        connection.sessionId = paired.sessionId;
        connection.authenticated = true;
        this.#send(connection, { type: "paired", requestId: message.requestId, ...paired });
        void audit({ action: "bridge_pair", ok: true, extensionId: message.extensionId, sessionId: paired.sessionId });
      } catch (error) {
        this.#send(connection, { type: "error", requestId: message.requestId, code: "pair_failed", message: error instanceof Error ? error.message : "Pairing failed." });
        void audit({ action: "bridge_pair", ok: false, extensionId: message.extensionId });
      }
      return;
    }

    if (!connection.authenticated) {
      this.#send(connection, { type: "error", code: "not_authenticated", message: "Pairing is required." });
      return;
    }

    if (message.type === "result") {
      const pending = this.#pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.requestId);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || "Browser command failed."));
      return;
    }

    if (message.type === "chunk") {
      const pending = this.#pending.get(message.requestId);
      if (!pending) return;
      const chunks = pending.chunks.get(message.artifact) || new Array<string>(message.total);
      chunks[message.index] = message.data;
      pending.chunks.set(message.artifact, chunks);
      return;
    }

    if (message.type === "progress" || message.type === "event") {
      void audit({ action: `bridge_${message.type}`, extensionId: connection.extensionId, detail: message });
    }
  }

  #send(connection: Connection, message: BridgeServerMessage): void {
    if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify(message));
  }
}
