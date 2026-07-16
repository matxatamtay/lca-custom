import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { once } from "node:events";
import WebSocket from "ws";
import { BridgeServer } from "../apps/server/src/bridge/bridge-server.js";
import { PairingManager } from "../apps/server/src/security/pairing.js";
import { PROTOCOL_VERSION } from "../packages/protocol/src/index.js";

const extensionId = "a".repeat(32);
const origin = `chrome-extension://${extensionId}`;

function managerForTest(): PairingManager {
  return new PairingManager(path.join(os.tmpdir(), `lba-bridge-pairing-${randomUUID()}.json`));
}

test("websocket bridge pairs, re-authenticates, and completes a command", async (t) => {
  const pairing = managerForTest();
  const bridge = new BridgeServer(pairing);
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => bridge.handleUpgrade(request, socket, head));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}/bridge`;

  t.after(() => {
    bridge.close();
    server.close();
  });

  const first = new WebSocket(url, { origin });
  const firstMessages = createMessageQueue(first);
  await once(first, "open");
  await firstMessages.next();
  first.send(JSON.stringify({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    extensionId,
    extensionVersion: "0.1.0",
    capabilities: ["capture"]
  }));
  const welcome = await firstMessages.next();
  assert.equal(welcome.type, "welcome");
  assert.equal(welcome.authenticated, false);

  first.send(JSON.stringify({ type: "pair", requestId: "pair-1", code: pairing.currentCode().code, extensionId }));
  const paired = await firstMessages.next();
  assert.equal(paired.type, "paired");
  first.close();
  await once(first, "close");

  const second = new WebSocket(url, { origin });
  const secondMessages = createMessageQueue(second);
  await once(second, "open");
  await secondMessages.next();
  second.send(JSON.stringify({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    extensionId,
    extensionVersion: "0.1.0",
    capabilities: ["capture"],
    token: paired.token
  }));
  const authenticated = await secondMessages.next();
  assert.equal(authenticated.authenticated, true);

  const pendingCommand = bridge.sendCommand("listTabs");
  const command = await secondMessages.next();
  assert.equal(command.type, "command");
  second.send(JSON.stringify({ type: "result", requestId: command.requestId, ok: true, result: [{ id: 1 }] }));
  assert.deepEqual(await pendingCommand, [{ id: 1 }]);
  second.close();
  await once(second, "close");
});

test("websocket bridge rejects non-extension origins", async () => {
  const bridge = new BridgeServer(managerForTest());
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => bridge.handleUpgrade(request, socket, head));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, { origin: "https://evil.example" });
  const outcome = await Promise.race([
    once(ws, "unexpected-response").then(() => "rejected"),
    once(ws, "error").then(() => "rejected"),
    once(ws, "open").then(() => "opened")
  ]);
  assert.equal(outcome, "rejected");
  bridge.close();
  server.close();
});

function createMessageQueue(socket: WebSocket) {
  const queue: any[] = [];
  const waiters: Array<(value: any) => void> = [];
  socket.on("message", (raw) => {
    const value = JSON.parse(raw.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else queue.push(value);
  });
  return {
    next(): Promise<any> {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => waiters.push(resolve));
    }
  };
}
