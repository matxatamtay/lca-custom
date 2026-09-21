// Local Coding Agent — official Figma Remote MCP bridge facade
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";
import { normalizeTimeout, persistentHttpClientKey } from "./persistent-http-mcp-client.mjs";
import {
  DEFAULT_FIGMA_REMOTE_MCP_URL, DEFAULT_FIGMA_REMOTE_TOKEN_PATH, FigmaRemoteMcpClient,
  normalizeFigmaRemoteCallbackUrl, normalizeFigmaRemoteEndpoint
} from "./figma-remote-runtime.mjs";

export {
  DEFAULT_FIGMA_REMOTE_MCP_URL, DEFAULT_FIGMA_REMOTE_TOKEN_PATH,
  FigmaRemoteAuthorizationRequiredError, figmaRemoteToolAccess, friendlyFigmaRemoteError,
  normalizeFigmaRemoteCallbackUrl, normalizeFigmaRemoteEndpoint
} from "./figma-remote-runtime.mjs";

const DEFAULT_TIMEOUT_MS = 60_000;

const clients = new Map();

function getFigmaRemoteClient(options = {}) {
  const endpoint = normalizeFigmaRemoteEndpoint(options.endpoint, { allowInsecure: options.allowInsecure });
  const timeoutMs = normalizeTimeout(options.timeoutMs ?? process.env.FIGMA_REMOTE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const authToken = String(options.authToken ?? process.env.FIGMA_REMOTE_AUTH_TOKEN ?? "").trim();
  const clientId = String(options.clientId ?? process.env.FIGMA_REMOTE_CLIENT_ID ?? "").trim();
  const clientSecret = String(options.clientSecret ?? process.env.FIGMA_REMOTE_CLIENT_SECRET ?? "").trim();
  const allowWrite = options.allowWrite ?? process.env.FIGMA_REMOTE_ALLOW_WRITE === "1";
  const callbackUrl = normalizeFigmaRemoteCallbackUrl(options.callbackUrl ?? process.env.FIGMA_REMOTE_CALLBACK_URL);
  const tokenPath = path.resolve(String(options.tokenPath ?? process.env.FIGMA_REMOTE_TOKEN_PATH ?? DEFAULT_FIGMA_REMOTE_TOKEN_PATH));
  const allowInsecure = options.allowInsecure === true || process.env.FIGMA_REMOTE_ALLOW_INSECURE === "1";
  const clientName = String(options.clientName || "local-coding-agent-figma-remote");
  const credentialKey = [authToken, clientId, clientSecret].filter(Boolean).join(":");
  const key = `${persistentHttpClientKey({ endpoint, authToken: credentialKey, clientName })}|timeout=${timeoutMs}|callback=${callbackUrl}|token=${tokenPath}|write=${allowWrite}|insecure=${allowInsecure}`;
  let client = clients.get(key);
  if (!client) {
    client = new FigmaRemoteMcpClient({
      endpoint,
      timeoutMs,
      authToken,
      clientId,
      clientSecret,
      allowWrite,
      callbackUrl,
      tokenPath,
      allowInsecure,
      clientName
    });
    clients.set(key, client);
  }
  return client;
}

export async function figmaRemoteStatus(options = {}) {
  return getFigmaRemoteClient(options).status();
}

export async function startFigmaRemoteAuthorization(options = {}) {
  return getFigmaRemoteClient(options).startAuthorization();
}

export async function finishFigmaRemoteAuthorization(callback, options = {}) {
  return getFigmaRemoteClient(options).finishAuthorization(callback || {});
}

export async function resetFigmaRemoteAuthorization(options = {}) {
  return getFigmaRemoteClient(options).resetAuthorization();
}

export async function listFigmaRemoteTools(options = {}) {
  return getFigmaRemoteClient(options).listTools({ refresh: options.refresh === true });
}

export async function callFigmaRemoteTool(name, args = {}, options = {}) {
  return getFigmaRemoteClient(options).callTool(name, args);
}

export async function closeFigmaRemoteClients() {
  const active = [...clients.values()];
  clients.clear();
  await Promise.all(active.map((client) => client.close().catch(() => undefined)));
}
