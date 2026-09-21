import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export function createHttpRuntime(options) {
  const {
    ALLOWED_ORIGINS, AUTH_TOKEN, COMPANION_WIDGET_RESOURCE, COMPANION_WIDGET_URI, CONFIG_ID,
    DBEAVER_SQL_ARTIFACT_LEGACY_URI, DBEAVER_SQL_ARTIFACT_RESOURCE, DBEAVER_SQL_ARTIFACT_URI,
    FIGMA_REMOTE_ENABLED, HOST, HTTP_LOG, MAX_BODY_BYTES, PORT, PRIMARY_ROOT, PRODUCT_TIER,
    RECORD_AGENTMEMORY_SESSIONS, ROOTS, TOOL_SURFACE, VERSION, cleanupRuntime, createMcpServer,
    figmaRemoteBridgeOptions, finishFigmaRemoteAuthorization, lifecycleLog, log
  } = options;

  function originAllowed(req) {
    const origin = String(req.headers.origin || "").trim();
    if (!origin) return true;
    return ALLOWED_ORIGINS.has(origin);
  }

  function setCors(req, res) {
    const origin = String(req.headers.origin || "").trim();
    if (!origin || !ALLOWED_ORIGINS.has(origin)) return;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, mcp-protocol-version, mcp-session-id");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  }

  function readJsonBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
      let size = 0;
      let overflow = false;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          overflow = true;
          return;
        }
        if (!overflow) chunks.push(chunk);
      });
      req.on("end", () => {
        if (overflow) {
          reject(Object.assign(new Error("Payload too large."), { statusCode: 413 }));
          return;
        }
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve(raw ? JSON.parse(raw) : undefined);
        } catch {
          reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 }));
        }
      });
      req.on("error", reject);
    });
  }

  function sendJson(res, status, value) {
    if (res.headersSent || res.destroyed) return;
    const body = JSON.stringify(value);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  }

  function oauthProtectedResourceMetadata() {
    return {
      resource: `http://${HOST}:${PORT}/mcp`,
      authorization_servers: ["https://auth.openai.com"],
      bearer_methods_supported: ["header"]
    };
  }

  function checkAuth(req) {
    if (!AUTH_TOKEN) return true;
    const header = req.headers["authorization"] || "";
    const fromHeader = header.startsWith("Bearer ") ? header.slice(7) : "";
    const left = Buffer.from(String(fromHeader));
    const right = Buffer.from(String(AUTH_TOKEN));
    return left.length === right.length && timingSafeEqual(left, right);
  }

  function sendFigmaOAuthPage(res, statusCode, title, message) {
    const escapeHtml = (value) => String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:680px;margin:12vh auto;padding:24px;color:#18181b}main{border:1px solid #e4e4e7;border-radius:18px;padding:28px;box-shadow:0 12px 40px #00000012}h1{margin:0 0 12px;font-size:24px}p{line-height:1.55;color:#52525b}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
    res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  }

  async function handleFigmaRemoteOAuthCallback(url, res) {
    const oauthError = String(url.searchParams.get("error") || "").trim();
    const oauthDescription = String(url.searchParams.get("error_description") || "").trim();
    try {
      if (!FIGMA_REMOTE_ENABLED) throw new Error("Figma Remote MCP is not enabled in LCA.");
      if (oauthError) throw new Error(oauthDescription || oauthError);
      const result = await finishFigmaRemoteAuthorization(
        { code: url.searchParams.get("code"), state: url.searchParams.get("state") },
        figmaRemoteBridgeOptions()
      );
      return sendFigmaOAuthPage(res, 200, "Figma connected", `LCA is connected to Figma Remote MCP with ${result.tool_count || 0} tools. You can close this tab.`);
    } catch (error) {
      return sendFigmaOAuthPage(res, 400, "Figma connection failed", error?.message || String(error));
    }
  }

  async function handleMcp(req, res) {
    if (req.method !== "POST") {
      return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    }
    const len = Number(req.headers["content-length"] || 0);
    if (len > MAX_BODY_BYTES) {
      return sendJson(res, 413, { jsonrpc: "2.0", error: { code: -32002, message: "Payload too large." }, id: null });
    }
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    await transport.handleRequest(req, res, body);
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
      if (HTTP_LOG) log(`${req.method} ${requestUrl.pathname} ua=${req.headers["user-agent"] || ""}`);
      if (!originAllowed(req)) return sendJson(res, 403, { error: "browser_origin_not_allowed" });
      setCors(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const url = requestUrl;
      if (req.method === "GET" && url.pathname === "/") {
        return sendJson(res, 200, { status: "ok", version: VERSION, runtime: "trusted-local", tool_surface: TOOL_SURFACE, roots: ROOTS, mcp_endpoint: `http://${HOST}:${PORT}/mcp` });
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, {
          status: "ok", version: VERSION, tier: PRODUCT_TIER, pid: process.pid, runtime: "trusted-local",
          tool_surface: TOOL_SURFACE, agentmemory_session_recording: RECORD_AGENTMEMORY_SESSIONS,
          auth: AUTH_TOKEN ? "bearer" : "none", config_id: CONFIG_ID || null, roots: ROOTS,
          workspace: PRIMARY_ROOT, mcp_endpoint: `http://${HOST}:${PORT}/mcp`,
          app_resources: {
            companion_widget: { uri: COMPANION_WIDGET_URI, bytes: COMPANION_WIDGET_RESOURCE.bytes, sha256: COMPANION_WIDGET_RESOURCE.sha256 },
            dbeaver_sql_artifact: { uri: DBEAVER_SQL_ARTIFACT_URI, legacy_uri: DBEAVER_SQL_ARTIFACT_LEGACY_URI, bytes: DBEAVER_SQL_ARTIFACT_RESOURCE.bytes, sha256: DBEAVER_SQL_ARTIFACT_RESOURCE.sha256 }
          }
        });
      }
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") return sendJson(res, 200, oauthProtectedResourceMetadata());
      if (req.method === "GET" && url.pathname === "/integrations/figma/oauth/callback") return await handleFigmaRemoteOAuthCallback(url, res);
      if (url.pathname === "/mcp") {
        if (!checkAuth(req)) return sendJson(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized." }, id: null });
        return await handleMcp(req, res);
      }
      return sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) return sendJson(res, error?.statusCode || 500, { error: error?.message || "Internal Server Error" });
    }
  });

  httpServer.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(`FATAL: MCP port ${PORT} is already in use — another server instance is likely running. Exiting.`);
      process.exit(1);
    }
    log(`httpServer error: ${err?.message || err}`);
  });

  process.on("uncaughtException", (err) => log(`uncaughtException: ${err?.stack || err}`));
  process.on("unhandledRejection", (err) => log(`unhandledRejection: ${err?.stack || err}`));
  let gracefulExitPromise;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (gracefulExitPromise) return;
      gracefulExitPromise = gracefulExit(signal);
    });
  }

  async function gracefulExit(signal) {
    const forceExit = setTimeout(() => process.exit(1), 15_000);
    forceExit.unref();
    await lifecycleLog(`${signal} received`);
    try {
      await cleanupRuntime(signal);
      await lifecycleLog(`${signal} cleanup completed`);
    } catch (error) {
      await lifecycleLog(`${signal} cleanup failed: ${error?.stack || error}`);
    } finally {
      clearTimeout(forceExit);
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    }
  }

  function startHttpServer() {
    httpServer.listen(PORT, HOST, () => {
      console.log(`Local Coding Agent v${VERSION} listening on http://${HOST}:${PORT}`);
      console.log(`Runtime: trusted-local  Surface: ${TOOL_SURFACE}  Auth: ${AUTH_TOKEN ? "bearer" : "none (tunnel-only)"}`);
      console.log(`Roots:\n${ROOTS.map((root) => `  - ${root}`).join("\n")}`);
      console.log(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
    });
  }

  return { httpServer, startHttpServer };
}
