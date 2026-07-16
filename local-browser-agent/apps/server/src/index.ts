import http from "node:http";
import { mkdir } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ArtifactStore } from "./captures/artifact-store.js";
import { BridgeServer } from "./bridge/bridge-server.js";
import { createBrowserMcpServer } from "./mcp/create-mcp-server.js";
import { PairingManager } from "./security/pairing.js";
import { audit } from "./security/audit.js";
import { DATA_DIR, HOST, MAX_BODY_BYTES, MCP_AUTH_TOKEN, PORT, VERSION } from "./config.js";

await mkdir(DATA_DIR, { recursive: true });
const pairing = new PairingManager();
const artifacts = new ArtifactStore();
await artifacts.init();
const bridge = new BridgeServer(pairing);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${HOST}:${PORT}`}`);
    if (request.method === "GET" && url.pathname === "/") {
      return sendJson(response, 200, { status: "ok", name: "Local Browser Agent", version: VERSION, mcp: `http://${HOST}:${PORT}/mcp` });
    }
    if (request.method === "GET" && url.pathname === "/healthz") {
      return sendJson(response, 200, {
        status: "ok",
        version: VERSION,
        pid: process.pid,
        host: HOST,
        port: PORT,
        auth: MCP_AUTH_TOKEN ? "bearer" : "none",
        bridge: bridge.status()
      });
    }
    if (url.pathname === "/mcp") {
      if (!originAllowed(request)) return sendJson(response, 403, { error: "browser_origin_not_allowed" });
      if (!authorized(request)) return sendJson(response, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized." }, id: null });
      if (request.method !== "POST") return sendJson(response, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
      const body = await readJsonBody(request, MAX_BODY_BYTES);
      const mcp = createBrowserMcpServer(bridge, artifacts);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      return await transport.handleRequest(request, response, body);
    }
    return sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    void audit({ action: "http_error", error: error instanceof Error ? error.message : String(error) });
    if (!response.headersSent) sendJson(response, (error as any)?.statusCode || 500, { error: error instanceof Error ? error.message : "Internal Server Error" });
  }
});

server.on("upgrade", (request, socket, head) => bridge.handleUpgrade(request, socket, head));
server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
server.listen(PORT, HOST, () => {
  const current = pairing.currentCode();
  console.log(`Local Browser Agent v${VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
  console.log(`Extension bridge: ws://${HOST}:${PORT}/bridge`);
  console.log(`Pairing code: ${current.code} (expires ${current.expiresAt})`);
});

const cleanupTimer = setInterval(() => void artifacts.cleanupExpired(), 5 * 60_000);
cleanupTimer.unref();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(cleanupTimer);
    bridge.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_500).unref();
  });
}

function authorized(request: http.IncomingMessage): boolean {
  if (!MCP_AUTH_TOKEN) return true;
  const authorization = String(request.headers.authorization || "");
  const candidate = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const actual = Buffer.from(candidate);
  const expected = Buffer.from(MCP_AUTH_TOKEN);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function originAllowed(request: http.IncomingMessage): boolean {
  const origin = String(request.headers.origin || "");
  if (!origin) return true;
  return origin === `http://${HOST}:${PORT}` || origin === `http://localhost:${PORT}`;
}

function readJsonBody(request: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (overflow) return reject(Object.assign(new Error("Payload too large."), { statusCode: 413 }));
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}
