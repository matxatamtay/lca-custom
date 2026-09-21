// Local Coding Agent — official Figma Remote MCP bridge
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { normalizeTimeout, withTimeout } from "./persistent-http-mcp-client.mjs";

export const DEFAULT_FIGMA_REMOTE_MCP_URL = "https://mcp.figma.com/mcp";
export const DEFAULT_FIGMA_REMOTE_TOKEN_PATH = path.join(os.homedir(), ".config", "lca-custom", "figma-oauth.json");
const DEFAULT_TIMEOUT_MS = 60_000;

const KNOWN_READ_TOOLS = new Set([
  "get_code_connect_map",
  "get_code_connect_suggestions",
  "get_context_for_code_connect",
  "get_design_context",
  "get_figjam",
  "get_make_resources",
  "get_metadata",
  "get_screenshot",
  "get_shader_effect",
  "get_shader_fill",
  "get_variable_defs",
  "list_shader_effects",
  "list_shader_fills",
  "whoami"
]);

const KNOWN_WRITE_TOOLS = new Set([
  "add_code_connect_map",
  "create_new_file",
  "download_assets",
  "generate_diagram",
  "generate_figma_design",
  "use_figma"
]);

export class FigmaRemoteAuthorizationRequiredError extends Error {
  constructor(details = {}) {
    super("Figma Remote MCP authorization is required.");
    this.name = "FigmaRemoteAuthorizationRequiredError";
    this.details = details;
  }
}

export function normalizeFigmaRemoteEndpoint(value = process.env.FIGMA_REMOTE_MCP_URL || DEFAULT_FIGMA_REMOTE_MCP_URL, options = {}) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_FIGMA_REMOTE_MCP_URL).trim());
  } catch {
    throw new Error("FIGMA_REMOTE_MCP_URL must be a valid HTTP URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("FIGMA_REMOTE_MCP_URL must use http or https.");
  const allowInsecure = options.allowInsecure === true || process.env.FIGMA_REMOTE_ALLOW_INSECURE === "1";
  if (url.protocol !== "https:" && !allowInsecure) {
    throw new Error("Figma Remote MCP must use HTTPS unless FIGMA_REMOTE_ALLOW_INSECURE=1.");
  }
  if (url.pathname === "/" || !url.pathname) url.pathname = "/mcp";
  url.hash = "";
  return url.toString();
}

export function normalizeFigmaRemoteCallbackUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("FIGMA_REMOTE_CALLBACK_URL must be a valid HTTP URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("FIGMA_REMOTE_CALLBACK_URL must use http or https.");
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) throw new Error("An HTTP Figma OAuth callback must use a loopback host.");
  url.hash = "";
  return url.toString();
}

export function figmaRemoteToolAccess(tool) {
  if (!tool || typeof tool !== "object") return { readOnly: false, known: false, source: "unknown" };
  const name = String(tool.name || "").trim();
  const hint = tool.annotations?.readOnlyHint;
  if (hint === true) return { readOnly: true, known: true, source: "annotation" };
  if (hint === false) return { readOnly: false, known: true, source: "annotation" };
  if (KNOWN_READ_TOOLS.has(name)) return { readOnly: true, known: true, source: "allowlist" };
  if (KNOWN_WRITE_TOOLS.has(name)) return { readOnly: false, known: true, source: "denylist" };
  return { readOnly: false, known: false, source: "unknown" };
}

class FileOAuthProvider {
  constructor({ redirectUrl, storagePath, clientName, clientId, clientSecret }) {
    this._redirectUrl = normalizeFigmaRemoteCallbackUrl(redirectUrl);
    this.storagePath = path.resolve(String(storagePath || DEFAULT_FIGMA_REMOTE_TOKEN_PATH));
    this.clientName = String(clientName || "Local Coding Agent Figma Bridge");
    this.clientId = String(clientId || "").trim();
    this.clientSecret = String(clientSecret || "").trim();
    this._dataPromise = undefined;
  }

  get redirectUrl() {
    return this._redirectUrl;
  }

  get clientMetadata() {
    return {
      client_name: this.clientName,
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.clientSecret ? "client_secret_post" : "none"
    };
  }

  async clientInformation() {
    if (this.clientId) {
      return {
        client_id: this.clientId,
        ...(this.clientSecret ? { client_secret: this.clientSecret } : {})
      };
    }
    return (await this.#data()).clientInformation;
  }

  async saveClientInformation(clientInformation) {
    if (this.clientId) return;
    await this.#update({ clientInformation });
  }

  async tokens() {
    return (await this.#data()).tokens;
  }

  async saveTokens(tokens) {
    await this.#update({ tokens, authorizedAt: new Date().toISOString() });
  }

  async state() {
    const oauthState = randomBytes(24).toString("base64url");
    await this.#update({ oauthState, authorizationUrl: undefined, authorizationStartedAt: undefined });
    return oauthState;
  }

  async redirectToAuthorization(authorizationUrl) {
    await this.#update({ authorizationUrl: authorizationUrl.toString(), authorizationStartedAt: new Date().toISOString() });
  }

  async saveCodeVerifier(codeVerifier) {
    await this.#update({ codeVerifier });
  }

  async codeVerifier() {
    const value = (await this.#data()).codeVerifier;
    if (!value) throw new Error("No Figma OAuth PKCE verifier is available. Start authorization again.");
    return value;
  }

  async saveDiscoveryState(discoveryState) {
    await this.#update({ discoveryState });
  }

  async discoveryState() {
    return (await this.#data()).discoveryState;
  }

  async invalidateCredentials(scope) {
    const next = { ...(await this.#data()) };
    if (scope === "all" || scope === "client") delete next.clientInformation;
    if (scope === "all" || scope === "tokens") delete next.tokens;
    if (scope === "all" || scope === "verifier") {
      delete next.codeVerifier;
      delete next.oauthState;
      delete next.authorizationUrl;
      delete next.authorizationStartedAt;
    }
    if (scope === "all" || scope === "discovery") delete next.discoveryState;
    await this.#replace(next);
  }

  async authorizationDetails() {
    const data = await this.#data();
    return {
      authorization_url: data.authorizationUrl || null,
      callback_url: this._redirectUrl,
      started_at: data.authorizationStartedAt || null
    };
  }

  async validateCallbackState(state) {
    const expected = String((await this.#data()).oauthState || "");
    if (!expected || expected !== String(state || "")) {
      throw new Error("Figma OAuth callback state is missing or does not match. Start authorization again.");
    }
  }

  async hasTokens() {
    return Boolean((await this.#data()).tokens?.access_token);
  }

  async clear() {
    this._dataPromise = Promise.resolve({});
    await rm(this.storagePath, { force: true }).catch(() => undefined);
  }

  async #data() {
    if (!this._dataPromise) {
      this._dataPromise = readFile(this.storagePath, "utf8")
        .then((text) => {
          const parsed = JSON.parse(text);
          return parsed && typeof parsed === "object" ? parsed : {};
        })
        .catch((error) => {
          if (error?.code === "ENOENT") return {};
          throw new Error(`Unable to read Figma OAuth state: ${error?.message || error}`);
        });
    }
    return this._dataPromise;
  }

  async #update(patch) {
    const next = { ...(await this.#data()) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    await this.#replace(next);
  }

  async #replace(next) {
    await mkdir(path.dirname(this.storagePath), { recursive: true });
    const temporaryPath = `${this.storagePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600).catch(() => undefined);
    await rename(temporaryPath, this.storagePath);
    await chmod(this.storagePath, 0o600).catch(() => undefined);
    this._dataPromise = Promise.resolve(next);
  }
}

export class FigmaRemoteMcpClient {
  constructor(options) {
    this.endpoint = normalizeFigmaRemoteEndpoint(options.endpoint, { allowInsecure: options.allowInsecure });
    this.timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.authToken = String(options.authToken || "").trim();
    this.clientId = String(options.clientId || "").trim();
    this.allowWrite = options.allowWrite === true;
    this.clientName = String(options.clientName || "local-coding-agent-figma-remote");
    this.provider = this.authToken
      ? null
      : new FileOAuthProvider({
          redirectUrl: options.callbackUrl,
          storagePath: options.tokenPath,
          clientName: "Local Coding Agent Figma Bridge",
          clientId: options.clientId,
          clientSecret: options.clientSecret
        });
    this.connection = undefined;
    this.connectionPromise = undefined;
    this.pendingAuth = undefined;
    this.toolsResult = undefined;
  }

  async ensureConnection() {
    if (this.connection) return this.connection;
    if (this.connectionPromise) return this.connectionPromise;
    if (this.pendingAuth && !this.authToken) {
      throw new FigmaRemoteAuthorizationRequiredError(await this.provider.authorizationDetails());
    }
    const pending = this.#connect().finally(() => {
      if (this.connectionPromise === pending) this.connectionPromise = undefined;
    });
    this.connectionPromise = pending;
    return pending;
  }

  async #connect() {
    const client = new Client({ name: this.clientName, version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.endpoint), {
      ...(this.provider ? { authProvider: this.provider } : {}),
      ...(this.authToken ? { requestInit: { headers: { Authorization: `Bearer ${this.authToken}` } } } : {})
    });
    try {
      await withTimeout(client.connect(transport), this.timeoutMs, "Connecting to Figma Remote MCP");
      const connection = {
        client,
        transport,
        listTools: () => client.listTools(),
        callTool: (input) => client.callTool(input),
        close: () => client.close()
      };
      this.connection = connection;
      this.pendingAuth = undefined;
      return connection;
    } catch (error) {
      if (error instanceof UnauthorizedError && this.provider) {
        this.pendingAuth = { client, transport };
        throw new FigmaRemoteAuthorizationRequiredError(await this.provider.authorizationDetails());
      }
      await client.close().catch(() => undefined);
      throw friendlyFigmaRemoteError(error, this.endpoint);
    }
  }

  async startAuthorization() {
    if (this.authToken) {
      await this.ensureConnection();
      return { connected: true, auth_mode: "bearer", authorization_required: false };
    }
    try {
      await this.ensureConnection();
      return { connected: true, auth_mode: "oauth", authorization_required: false };
    } catch (error) {
      if (error instanceof FigmaRemoteAuthorizationRequiredError) {
        return { connected: false, auth_mode: "oauth", authorization_required: true, ...error.details };
      }
      throw error;
    }
  }

  async finishAuthorization({ code, state }) {
    if (this.authToken) throw new Error("Figma Remote MCP is configured for bearer authentication, not OAuth.");
    const authorizationCode = String(code || "").trim();
    if (!authorizationCode) throw new Error("Figma OAuth callback did not include an authorization code.");
    await this.provider.validateCallbackState(state);
    const pending = this.pendingAuth;
    const transport = pending?.transport || new StreamableHTTPClientTransport(new URL(this.endpoint), { authProvider: this.provider });
    await withTimeout(transport.finishAuth(authorizationCode), this.timeoutMs, "Completing Figma OAuth");
    await pending?.client?.close().catch(() => undefined);
    this.pendingAuth = undefined;
    await this.#invalidateConnection();
    await this.ensureConnection();
    return this.status();
  }

  async listTools(options = {}) {
    if (!options.refresh && this.toolsResult) return this.toolsResult;
    const connection = await this.ensureConnection();
    const listed = await withTimeout(connection.listTools(), this.timeoutMs, "Figma Remote MCP tools/list");
    this.toolsResult = listed;
    return listed;
  }

  async callTool(name, args = {}) {
    const toolName = String(name || "").trim();
    if (!toolName) throw new Error("Figma Remote MCP tool name is required.");
    let listed = await this.listTools();
    let tool = listed.tools?.find((candidate) => candidate.name === toolName);
    if (!tool) {
      listed = await this.listTools({ refresh: true });
      tool = listed.tools?.find((candidate) => candidate.name === toolName);
    }
    if (!tool) {
      throw new Error(`Figma Remote MCP does not expose tool "${toolName}". Available: ${listed.tools?.map((item) => item.name).join(", ") || "none"}`);
    }
    const access = figmaRemoteToolAccess(tool);
    if (!access.readOnly && !this.allowWrite) {
      const reason = access.known ? "is write-capable" : "does not declare itself read-only";
      throw new Error(`Figma Remote tool "${toolName}" ${reason}. Set FIGMA_REMOTE_ALLOW_WRITE=1 and restart LCA to enable it.`);
    }
    const connection = await this.ensureConnection();
    return withTimeout(
      connection.callTool({ name: toolName, arguments: args || {} }),
      this.timeoutMs,
      `Figma Remote MCP tool ${toolName}`
    );
  }

  async status() {
    const hasStoredTokens = this.provider ? await this.provider.hasTokens() : false;
    try {
      const listed = await this.listTools();
      return {
        connected: true,
        endpoint: this.endpoint,
        auth_mode: this.authToken ? "bearer" : "oauth",
        auth_configured: Boolean(this.authToken || this.clientId || hasStoredTokens),
        authorization_required: false,
        write_enabled: this.allowWrite,
        token_path: this.provider?.storagePath || null,
        tool_count: listed.tools?.length || 0,
        tools: (listed.tools || []).map((tool) => ({
          name: tool.name,
          read_only: figmaRemoteToolAccess(tool).readOnly
        }))
      };
    } catch (error) {
      if (error instanceof FigmaRemoteAuthorizationRequiredError) {
        return {
          connected: false,
          endpoint: this.endpoint,
          auth_mode: "oauth",
          auth_configured: Boolean(this.clientId || hasStoredTokens),
          authorization_required: true,
          write_enabled: this.allowWrite,
          token_path: this.provider.storagePath,
          tool_count: 0,
          tools: [],
          ...error.details,
          error: error.message
        };
      }
      return {
        connected: false,
        endpoint: this.endpoint,
        auth_mode: this.authToken ? "bearer" : "oauth",
        auth_configured: Boolean(this.authToken || this.clientId || hasStoredTokens),
        authorization_required: false,
        write_enabled: this.allowWrite,
        token_path: this.provider?.storagePath || null,
        tool_count: 0,
        tools: [],
        error: error?.message || String(error)
      };
    }
  }

  async resetAuthorization() {
    await this.close();
    await this.provider?.clear();
    return {
      reset: true,
      token_path: this.provider?.storagePath || null,
      next: "Start Figma Remote authorization again."
    };
  }

  async #invalidateConnection() {
    const current = this.connection;
    this.connection = undefined;
    this.connectionPromise = undefined;
    this.toolsResult = undefined;
    await current?.close().catch(() => undefined);
  }

  async close() {
    await this.#invalidateConnection();
    await this.pendingAuth?.client?.close().catch(() => undefined);
    this.pendingAuth = undefined;
  }
}

export function friendlyFigmaRemoteError(error, endpoint = DEFAULT_FIGMA_REMOTE_MCP_URL) {
  const message = String(error?.cause?.message || error?.message || error || "Unknown error");
  const diagnostic = `${message}\n${String(error?.stack || "")}`;
  if (/client.+not.+supported|catalog|dynamic client registration|registration.+denied|invalid_client|registerClient|Invalid OAuth error response.*Forbidden/i.test(diagnostic)) {
    return new Error(
      "Figma rejected this custom MCP client. Figma currently limits the hosted MCP server to clients in its MCP Catalog; LCA must be approved by Figma or use credentials from an approved client registration."
    );
  }
  if (/401|403|Unauthorized|Forbidden|authorization/i.test(message)) {
    return new Error("Figma Remote MCP authentication failed. Start OAuth again or verify FIGMA_REMOTE_AUTH_TOKEN.");
  }
  if (/ECONNREFUSED|fetch failed|Failed to open SSE stream|socket hang up|timed out/i.test(message)) {
    return new Error(`Figma Remote MCP is unavailable at ${endpoint}.`);
  }
  return new Error(`Figma Remote MCP error: ${message}`);
}

