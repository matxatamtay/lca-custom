interface DevtoolsConnection {
  tabId: number;
  port: chrome.runtime.Port;
  connectedAt: string;
  latestState: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const connections = new Map<number, DevtoolsConnection>();
const pending = new Map<string, PendingRequest>();

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith("lba-devtools:")) return;
  const tabId = Number(port.name.slice("lba-devtools:".length));
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  const connection: DevtoolsConnection = { tabId, port, connectedAt: new Date().toISOString(), latestState: {} };
  connections.set(tabId, connection);

  port.onMessage.addListener((message) => {
    if (message?.type === "devtools:state") {
      connection.latestState = { ...connection.latestState, ...(message.state || {}) };
      return;
    }
    if (message?.type === "devtools:result" && typeof message.requestId === "string") {
      const request = pending.get(message.requestId);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.requestId);
      if (message.ok) request.resolve(message.result);
      else request.reject(new Error(message.error || "DevTools command failed."));
    }
  });
  port.onDisconnect.addListener(() => {
    if (connections.get(tabId)?.port === port) connections.delete(tabId);
  });
});

export function hasDevtoolsConnection(tabId: number): boolean {
  return connections.has(tabId);
}

export function getDevtoolsState(tabId: number): Record<string, unknown> | null {
  const connection = connections.get(tabId);
  return connection
    ? { connected: true, connectedAt: connection.connectedAt, ...connection.latestState }
    : null;
}

export function requestDevtools(tabId: number, command: string, args: unknown, timeoutMs = 20_000): Promise<unknown> {
  const connection = connections.get(tabId);
  if (!connection) return Promise.reject(new Error("DevTools companion is not connected for this tab."));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("DevTools companion timed out."));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    connection.port.postMessage({ type: "devtools:command", requestId, command, args });
  });
}
