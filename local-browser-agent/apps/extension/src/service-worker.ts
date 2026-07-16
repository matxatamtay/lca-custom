import { BridgeServerMessageSchema, PROTOCOL_VERSION, type BridgeServerMessage } from "../../../packages/protocol/src/index.js";
import { captureBrowserContext, listTabs } from "./capture.js";
import { interactBrowser, navigateBrowser } from "./browser-actions.js";
import { allowActiveTab, listAllowedTabs, revokeTab } from "./tab-consent.js";
import "./devtools-registry.js";

const BRIDGE_URL = "ws://127.0.0.1:8790/bridge";
const TOKEN_KEY = "lba.bridgeToken";
const VERSION = chrome.runtime.getManifest().version;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let authenticated = false;
let pairingRequired = true;
let sessionId: string | null = null;
let lastError: string | null = null;
const pairRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

connect();
chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleRuntimeMessage(message).then(sendResponse, (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function handleRuntimeMessage(message: any): Promise<unknown> {
  if (message?.type === "lba:getStatus") return { ok: true, ...status(), allowedTabs: await listAllowedTabs() };
  if (message?.type === "lba:pair") return await pair(String(message.code || ""));
  if (message?.type === "lba:allowActiveTab") return { ok: true, allowedTab: await allowActiveTab() };
  if (message?.type === "lba:revokeTab") {
    await revokeTab(Number(message.tabId));
    return { ok: true };
  }
  if (message?.type === "lba:reconnect") {
    disconnect(false);
    connect();
    return { ok: true };
  }
  if (message?.type === "lba:disconnect") {
    disconnect(true);
    return { ok: true };
  }
  return { ok: false, error: "Unknown request." };
}

function connect(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  lastError = null;
  socket = new WebSocket(BRIDGE_URL);
  socket.addEventListener("open", () => void sendHello());
  socket.addEventListener("message", (event) => void handleBridgeMessage(String(event.data)));
  socket.addEventListener("error", () => { lastError = "Could not connect to the local bridge."; });
  socket.addEventListener("close", () => {
    authenticated = false;
    sessionId = null;
    stopHeartbeat();
    reconnectTimer = setTimeout(connect, 2_500);
  });
}

async function sendHello(): Promise<void> {
  const stored = await chrome.storage.local.get(TOKEN_KEY);
  send({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    extensionId: chrome.runtime.id,
    extensionVersion: VERSION,
    browserVersion: navigator.userAgent,
    capabilities: [
      "debugger-capture", "devtools-companion", "dom-snapshot", "computed-styles", "visual-state",
      "html-snapshot", "screenshot", "console", "network", "performance", "accessibility", "navigate", "interact", "tab-control"
    ],
    token: typeof stored[TOKEN_KEY] === "string" ? stored[TOKEN_KEY] : undefined
  });
  startHeartbeat();
}

async function handleBridgeMessage(raw: string): Promise<void> {
  let message: BridgeServerMessage;
  try {
    message = BridgeServerMessageSchema.parse(JSON.parse(raw));
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Invalid server message.";
    return;
  }

  if (message.type === "welcome") {
    authenticated = message.authenticated;
    pairingRequired = message.pairingRequired;
    sessionId = message.sessionId || null;
    return;
  }
  if (message.type === "paired") {
    await chrome.storage.local.set({ [TOKEN_KEY]: message.token });
    authenticated = true;
    pairingRequired = false;
    sessionId = message.sessionId;
    pairRequests.get(message.requestId)?.resolve({ ok: true, sessionId: message.sessionId, expiresAt: message.expiresAt });
    pairRequests.delete(message.requestId);
    return;
  }
  if (message.type === "error") {
    lastError = message.message;
    if (message.requestId) {
      pairRequests.get(message.requestId)?.reject(new Error(message.message));
      pairRequests.delete(message.requestId);
    }
    return;
  }
  if (message.type === "ping") {
    send({ type: "event", event: "pong", payload: { nonce: message.nonce, at: new Date().toISOString() } });
    return;
  }
  if (message.type === "command") {
    await executeCommand(message);
  }
}

async function executeCommand(message: Extract<BridgeServerMessage, { type: "command" }>): Promise<void> {
  try {
    let result: unknown;
    if (message.command === "status") result = status();
    else if (message.command === "listTabs") result = await listTabs();
    else if (message.command === "capture") result = await captureBrowserContext(message.args);
    else if (message.command === "navigate") result = await navigateBrowser(message.args);
    else if (message.command === "interact") result = await interactBrowser(message.args);
    else if (message.command === "cancel") result = { cancelled: false, reason: "No cancellable capture is active." };
    else throw new Error("Unsupported command.");
    send({ type: "result", requestId: message.requestId, ok: true, result });
  } catch (error) {
    send({ type: "result", requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function pair(code: string): Promise<unknown> {
  if (!/^\d{6}$/.test(code)) return Promise.reject(new Error("Pairing code must contain six digits."));
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Local bridge is not connected."));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pairRequests.set(requestId, { resolve, reject });
    send({ type: "pair", requestId, code, extensionId: chrome.runtime.id });
    setTimeout(() => {
      if (!pairRequests.has(requestId)) return;
      pairRequests.delete(requestId);
      reject(new Error("Pairing timed out."));
    }, 10_000);
  });
}

function send(message: unknown): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Local bridge is not connected.");
  socket.send(JSON.stringify(message));
}

function status(): Record<string, unknown> {
  return {
    connected: socket?.readyState === WebSocket.OPEN,
    authenticated,
    pairingRequired,
    sessionId,
    extensionId: chrome.runtime.id,
    extensionVersion: VERSION,
    bridgeUrl: BRIDGE_URL,
    lastError
  };
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    try { send({ type: "event", event: "heartbeat", payload: { at: new Date().toISOString() } }); } catch {}
  }, 20_000);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function disconnect(clearToken: boolean): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopHeartbeat();
  socket?.close(1000, "User disconnect");
  socket = null;
  authenticated = false;
  sessionId = null;
  if (clearToken) void chrome.storage.local.remove(TOKEN_KEY);
}
