import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const JEV_ULTRAFAST_COMMIT = "1231850a0bf1a0c0341fe408ef1668dbbfdfac46";
export const JEV_ULTRAFAST_SOURCE =
  `jev-ultrafast @ git+https://github.com/browser-use/jev-ultrafast.git@${JEV_ULTRAFAST_COMMIT}`;
export const BROWSER_HARNESS_VERSION = "0.1.13";
export const BROWSER_HARNESS_SOURCE = `browser-harness[mcp]==${BROWSER_HARNESS_VERSION}`;
export const BROWSER_MCP_VERSION = "0.1.3";
export const BROWSER_MCP_SOURCE = `@browsermcp/mcp@${BROWSER_MCP_VERSION}`;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_AGENT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_STEPS = 20;
const DEFAULT_ISOLATED_CDP_PORT = 9223;
const clients = new Map<string, BrowserHarnessClient>();
let isolatedChromeProcess: ReturnType<typeof spawn> | undefined;

const BASE_ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "USER", "SHELL", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "SystemRoot", "ComSpec", "PATHEXT",
  "APPDATA", "LOCALAPPDATA"
]);

const JEV_ENV_KEYS = new Set([
  "JEV_API_TOKEN",
  "TYPESAFE_API_KEY",
  "TYPESAFE_MODEL"
]);

const LIVE_ENV_KEYS = new Set([
  ...JEV_ENV_KEYS,
  "LBA_BROWSER_MODE",
  "LBA_BROWSER_CHROME_BIN",
  "LBA_BROWSER_CDP_PORT",
  "LBA_BROWSER_PROFILE_DIR",
  "LBA_BROWSER_MCP_NPX_BIN",
  "LBA_BROWSER_MCP_SOURCE",
  "LBA_JEV_UV_BIN",
  "LBA_JEV_PYTHON",
  "LBA_JEV_SOURCE"
]);

function childEnvironment(extraKeys: ReadonlySet<string> = new Set()): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (
      BASE_ENV_ALLOWLIST.has(key)
      || extraKeys.has(key)
      || key.startsWith("BH_")
      || key.startsWith("BU_")
      || key.startsWith("BROWSER_HARNESS_")
    ) entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

function retryableTransportError(error: unknown): boolean {
  const value = error as { cause?: { message?: unknown }; message?: unknown };
  const message = String(value?.cause?.message || value?.message || error || "");
  return /closed|disconnect|connection|econn|broken pipe|transport|socket|terminated/i.test(message);
}

class BrowserHarnessClient {
  private client?: Client;
  private connectionPromise?: Promise<Client>;
  private tools?: Awaited<ReturnType<Client["listTools"]>>;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly timeoutMs: number
  ) {}

  private requestOptions() {
    return {
      timeout: this.timeoutMs,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: this.timeoutMs
    };
  }

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connectionPromise) return this.connectionPromise;
    this.connectionPromise = this.connect().finally(() => {
      this.connectionPromise = undefined;
    });
    return this.connectionPromise;
  }

  private async connect(): Promise<Client> {
    const client = new Client({ name: "lca-browser-harness-bridge", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: childEnvironment(),
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

  async listTools(refresh = false) {
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

  async callTool(name: string, args: Record<string, unknown>) {
    const client = await this.ensureConnected();
    try {
      return await client.callTool({ name, arguments: args }, undefined, this.requestOptions());
    } catch (error) {
      if (!retryableTransportError(error)) throw error;
      await this.invalidate(client);
      const replacement = await this.ensureConnected();
      return replacement.callTool({ name, arguments: args }, undefined, this.requestOptions());
    }
  }

  private async invalidate(client: Client): Promise<void> {
    if (this.client === client) {
      this.client = undefined;
      this.tools = undefined;
    }
    await client.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connectionPromise = undefined;
    this.tools = undefined;
    if (client) await client.close().catch(() => undefined);
  }
}

function getHarnessClient(options: {
  command?: string;
  source?: string;
  timeoutMs?: number;
} = {}): BrowserHarnessClient {
  const command = String(options.command || process.env.LBA_BROWSER_HARNESS_UVX_BIN || "uvx").trim();
  const source = String(options.source || process.env.LBA_BROWSER_HARNESS_SOURCE || BROWSER_HARNESS_SOURCE).trim();
  const timeoutMs = boundedNumber(
    options.timeoutMs ?? process.env.LBA_BROWSER_HARNESS_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    1_000,
    300_000
  );
  if (!command) throw new Error("Browser Harness uvx command cannot be empty.");
  if (!source) throw new Error("Browser Harness package source cannot be empty.");
  const args = ["--from", source, "browser-harness-mcp"];
  const key = JSON.stringify([command, args, timeoutMs]);
  let client = clients.get(key);
  if (!client) {
    client = new BrowserHarnessClient(command, args, timeoutMs);
    clients.set(key, client);
  }
  return client;
}

function getBrowserMcpClient(options: {
  command?: string;
  source?: string;
  timeoutMs?: number;
} = {}): BrowserHarnessClient {
  const command = String(options.command || process.env.LBA_BROWSER_MCP_NPX_BIN || "npx").trim();
  const source = String(options.source || process.env.LBA_BROWSER_MCP_SOURCE || BROWSER_MCP_SOURCE).trim();
  const timeoutMs = boundedNumber(
    options.timeoutMs ?? process.env.LBA_BROWSER_MCP_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    1_000,
    300_000
  );
  if (!command) throw new Error("Browser MCP npx command cannot be empty.");
  if (!source) throw new Error("Browser MCP package source cannot be empty.");
  const args = ["-y", source];
  const key = JSON.stringify(["browser-mcp", command, args, timeoutMs]);
  let client = clients.get(key);
  if (!client) {
    client = new BrowserHarnessClient(command, args, timeoutMs);
    clients.set(key, client);
  }
  return client;
}

export async function browserMcpStatus(): Promise<Record<string, unknown>> {
  try {
    const client = getBrowserMcpClient();
    const listed = await client.listTools();
    const snapshot = await client.callTool("browser_snapshot", {});
    const error = toolErrorText(snapshot);
    return {
      ok: true,
      package: BROWSER_MCP_SOURCE,
      persistent: true,
      extensionSelectedTabConnected: !error,
      extensionState: error || "connected",
      tools: (listed.tools || []).map((tool) => tool.name).filter((name) => name.startsWith("browser_"))
    };
  } catch (error) {
    return {
      ok: false,
      package: BROWSER_MCP_SOURCE,
      persistent: true,
      extensionSelectedTabConnected: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function listBrowserMcpTools(refresh = false) {
  const listed = await getBrowserMcpClient().listTools(refresh);
  return (listed.tools || [])
    .filter((tool) => tool.name.startsWith("browser_"))
    .map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.inputSchema || {}
    }));
}

export async function callBrowserMcpTool(
  name: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const toolName = String(name || "").trim();
  if (!/^browser_[a-z0-9_]+$/i.test(toolName)) {
    throw new Error("Only browser_* Browser MCP tools are allowed.");
  }
  const client = getBrowserMcpClient();
  const listed = await client.listTools();
  if (!(listed.tools || []).some((tool) => tool.name === toolName)) {
    throw new Error(`Browser MCP does not expose ${toolName}.`);
  }
  const result = await client.callTool(toolName, args);
  const errorText = toolErrorText(result);
  if (errorText) throw new Error(errorText);
  return unwrapMcpResult(result);
}

export async function browserHarnessStatus(): Promise<Record<string, unknown>> {
  try {
    const listed = await getHarnessClient().listTools();
    return {
      ok: true,
      package: BROWSER_HARNESS_SOURCE,
      tools: (listed.tools || []).map((tool) => tool.name).filter((name) => name.startsWith("browser_"))
    };
  } catch (error) {
    return {
      ok: false,
      package: BROWSER_HARNESS_SOURCE,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function listBrowserHarnessTools(refresh = false) {
  const listed = await getHarnessClient().listTools(refresh);
  return (listed.tools || [])
    .filter((tool) => tool.name.startsWith("browser_"))
    .map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.inputSchema || {}
    }));
}

export async function callBrowserHarnessTool(
  name: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const liveEnv = await readLiveRepoEnv(LIVE_ENV_KEYS);
  const toolName = String(name || "").trim();
  if (!/^browser_[a-z0-9_]+$/i.test(toolName)) {
    throw new Error("Only browser_* Browser Harness tools are allowed.");
  }
  const listed = await getHarnessClient().listTools();
  if (!(listed.tools || []).some((tool) => tool.name === toolName)) {
    throw new Error(`Browser Harness does not expose ${toolName}.`);
  }
  let result = await getHarnessClient().callTool(toolName, args);
  let errorText = toolErrorText(result);
  const mode = browserMode(liveEnv);
  if (
    errorText
    && mode !== "real"
    && shouldUseIsolatedFallback(errorText)
  ) {
    await ensureIsolatedChrome(liveEnv);
    result = await getHarnessClient().callTool(toolName, args);
    errorText = toolErrorText(result);
  }
  if (errorText) throw new Error(errorText);
  return unwrapMcpResult(result);
}

function unwrapMcpResult(result: Awaited<ReturnType<BrowserHarnessClient["callTool"]>>): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = Array.isArray(result.content)
    ? result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text
    : undefined;
  if (typeof text !== "string") return result;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function toolErrorText(result: Awaited<ReturnType<BrowserHarnessClient["callTool"]>>): string {
  const structured = result.structuredContent;
  if (
    structured
    && typeof structured === "object"
    && "error" in structured
    && typeof (structured as { error?: unknown }).error === "string"
  ) {
    return (structured as { error: string }).error;
  }
  const text = Array.isArray(result.content)
    ? result.content.map((item) => item.type === "text" ? item.text : "").filter(Boolean).join("\n")
    : "";
  if (result.isError) return text || "Browser Harness tool failed.";
  if (text) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed?.error === "string") return parsed.error;
    } catch {}
  }
  return "";
}

export async function runJevBrowserAgent(input: {
  url: string;
  goal: string;
  inputValues?: Record<string, string>;
  keepOpen?: boolean;
  maxSteps?: number;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const url = String(input.url || "").trim();
  const goal = String(input.goal || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("browser_agent url must use http or https.");
  if (!goal) throw new Error("browser_agent goal cannot be empty.");
  const inputValues: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input.inputValues || {})) {
    const key = String(rawKey).trim();
    if (!key) continue;
    inputValues[key] = String(rawValue);
  }
  if (Object.keys(inputValues).length > 100) {
    throw new Error("browser_agent inputValues supports at most 100 fields.");
  }
  if (Object.values(inputValues).some((value) => value.length > 20_000)) {
    throw new Error("browser_agent inputValues values must be at most 20000 characters.");
  }
  const maxSteps = boundedNumber(input.maxSteps, DEFAULT_MAX_STEPS, 1, 50);
  const timeoutMs = boundedNumber(input.timeoutMs, DEFAULT_AGENT_TIMEOUT_MS, 5_000, 600_000);
  const liveEnv = await readLiveRepoEnv(LIVE_ENV_KEYS);
  await callBrowserHarnessTool("browser_page_info").catch((error) => {
    throw new Error(`Browser Harness is not ready: ${error instanceof Error ? error.message : String(error)}`);
  });
  const env = childEnvironment(JEV_ENV_KEYS);
  Object.assign(env, pickEnv(liveEnv, JEV_ENV_KEYS));
  if (!env.TYPESAFE_API_KEY && env.JEV_API_TOKEN) env.TYPESAFE_API_KEY = env.JEV_API_TOKEN;
  if (!env.TYPESAFE_API_KEY) {
    throw new Error("Jev Ultrafast needs TYPESAFE_API_KEY or JEV_API_TOKEN.");
  }
  const command = String(liveEnv.LBA_JEV_UV_BIN || process.env.LBA_JEV_UV_BIN || "uv").trim();
  const python = String(liveEnv.LBA_JEV_PYTHON || process.env.LBA_JEV_PYTHON || "3.12").trim();
  const source = String(liveEnv.LBA_JEV_SOURCE || process.env.LBA_JEV_SOURCE || JEV_ULTRAFAST_SOURCE).trim();
  const payload = JSON.stringify({
    url,
    goal,
    input_values: inputValues,
    keep_open: input.keepOpen !== false,
    max_steps: maxSteps
  });
  const completed = await runProcess(
    command,
    ["run", "--python", python, "--quiet", "--with", source, "python", "-c", PYTHON_RUNNER],
    payload,
    env,
    timeoutMs
  );
  if (completed.code !== 0) {
    throw new Error(
      completed.stderr.trim()
      || completed.stdout.trim()
      || `Jev Ultrafast exited with code ${completed.code}.`
    );
  }
  const text = completed.stdout.trim();
  if (!text) throw new Error("Jev Ultrafast returned no result.");
  const lastLine = text.split(/\r?\n/).filter(Boolean).at(-1) || text;
  try {
    return JSON.parse(lastLine) as Record<string, unknown>;
  } catch {
    throw new Error(`Jev Ultrafast returned invalid JSON: ${lastLine.slice(0, 500)}`);
  }
}

export async function jevRuntimeStatus(): Promise<Record<string, unknown>> {
  const liveEnv = await readLiveRepoEnv(LIVE_ENV_KEYS);
  const apiReady = Boolean(liveEnv.TYPESAFE_API_KEY || liveEnv.JEV_API_TOKEN || process.env.TYPESAFE_API_KEY || process.env.JEV_API_TOKEN);
  return {
    ready: apiReady,
    callerSuppliedText: true,
    textModelRequired: false,
    browserMode: browserMode(liveEnv),
    isolatedFallbackPort: isolatedCdpPort(liveEnv),
    liveEnvReload: true
  };
}

export async function closeBrowserHarnessClients(): Promise<void> {
  const values = [...clients.values()];
  clients.clear();
  await Promise.all(values.map((client) => client.close()));
}

function browserMode(env: Record<string, string>): "auto" | "real" | "isolated" {
  const value = String(env.LBA_BROWSER_MODE || process.env.LBA_BROWSER_MODE || "auto").trim().toLowerCase();
  return value === "real" || value === "isolated" ? value : "auto";
}

function isolatedCdpPort(env: Record<string, string>): number {
  return boundedNumber(
    env.LBA_BROWSER_CDP_PORT || process.env.LBA_BROWSER_CDP_PORT,
    DEFAULT_ISOLATED_CDP_PORT,
    1024,
    65535
  );
}

function shouldUseIsolatedFallback(message: string): boolean {
  return /daemon .*didn't come up|chrome-not-running|remote debugging|DevToolsActivePort|permission-blocked|browser connection/i.test(message);
}

async function ensureIsolatedChrome(env: Record<string, string>): Promise<string> {
  const port = isolatedCdpPort(env);
  const endpoint = `http://127.0.0.1:${port}`;
  if (await devtoolsEndpointReady(endpoint)) return endpoint;

  const binary = resolveChromeBinary(env);
  const profileDir = path.resolve(
    env.LBA_BROWSER_PROFILE_DIR
      || process.env.LBA_BROWSER_PROFILE_DIR
      || path.join(os.homedir(), ".config", "local-coding-agent", "browser-profile")
  );
  await mkdir(profileDir, { recursive: true });
  if (!isolatedChromeProcess || isolatedChromeProcess.exitCode !== null || isolatedChromeProcess.killed) {
    const child = spawn(binary, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-component-update",
      "--disable-background-networking",
      "--headless=new",
      "about:blank"
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    isolatedChromeProcess = child;
    child.once("exit", () => {
      if (isolatedChromeProcess === child) isolatedChromeProcess = undefined;
    });
  }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await devtoolsEndpointReady(endpoint)) return endpoint;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Isolated Chrome failed to expose CDP at ${endpoint}.`);
}

async function devtoolsEndpointReady(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

function resolveChromeBinary(env: Record<string, string>): string {
  const configured = String(env.LBA_BROWSER_CHROME_BIN || process.env.LBA_BROWSER_CHROME_BIN || "").trim();
  if (configured) {
    if (!existsSync(configured)) throw new Error(`Configured Chrome binary does not exist: ${configured}`);
    return configured;
  }
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium"
      ]
    : process.platform === "win32"
      ? [
          path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error("No Chrome/Chromium binary found for isolated browser fallback.");
  return found;
}

async function readLiveRepoEnv(keys: ReadonlySet<string>): Promise<Record<string, string>> {
  const file = path.resolve(
    process.env.LBA_ENV_FILE || path.join(process.cwd(), "..", ".env.local")
  );
  let raw = "";
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return {};
  }
  const result: Record<string, string> = {};
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    const key = match?.[1];
    const rawValue = match?.[2];
    if (!key || rawValue === undefined || !keys.has(key)) continue;
    result[key] = parseDotEnvValue(rawValue);
  }
  return result;
}

function parseDotEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function pickEnv(env: Record<string, string>, keys: ReadonlySet<string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => keys.has(key)));
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function runProcess(
  command: string,
  args: string[],
  stdin: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 4_000_000) stdout = stdout.slice(-4_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 1_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

const PYTHON_RUNNER = String.raw`
import json, sys
from jev_ultrafast import Agent
import jev_ultrafast.agent as agent_module

request = json.load(sys.stdin)
agent_module.MAX_STEPS = int(request.get("max_steps", 20))
input_values = {
    str(key).strip(): str(value)
    for key, value in (request.get("input_values") or {}).items()
    if str(key).strip()
}

def normalize_field_key(value):
    return " ".join(str(value or "").strip().lower().split())

def supplied_field_text(context):
    field = context.get("field") or {}
    label = normalize_field_key(field.get("label"))
    role = normalize_field_key(field.get("role"))
    normalized = [(normalize_field_key(key), key, value) for key, value in input_values.items()]

    exact = [(key, value) for normalized_key, key, value in normalized if normalized_key in {label, role}]
    if len(exact) == 1:
        key, value = exact[0]
        return value, {"model": "caller-supplied:" + key, "latency_ms": 0, "usage": {}}
    if len(exact) > 1:
        raise ValueError("Multiple caller-supplied inputValues exactly match this field; use more specific keys.")

    partial = []
    for normalized_key, key, value in normalized:
        if not normalized_key:
            continue
        if (
            (label and (normalized_key in label or label in normalized_key))
            or (role and normalized_key == role)
        ):
            partial.append((len(normalized_key), key, value))
    if partial:
        partial.sort(reverse=True)
        best_length = partial[0][0]
        best = [(key, value) for length, key, value in partial if length == best_length]
        if len(best) == 1:
            key, value = best[0]
            return value, {"model": "caller-supplied:" + key, "latency_ms": 0, "usage": {}}
        raise ValueError("Multiple caller-supplied inputValues ambiguously match this field; use the exact field label.")

    visible = field.get("label") or field.get("role") or "unknown field"
    raise ValueError(
        f"TYPE_TEXT needs a caller-supplied inputValues entry for {visible!r}. "
        "Pass the deterministic value from the LCA test case."
    )

agent_module.field_text = supplied_field_text
agent = Agent(request["url"], request["goal"], screenshots=False)
last = agent.snapshot()
try:
    for state in agent.run():
        last = state
    history = []
    for item in last.get("history", []):
        history.append({
            "step": item.get("step"),
            "action": item.get("action"),
            "kind": item.get("kind"),
            "operation": item.get("operation"),
            "target": item.get("target"),
            "confidence": item.get("confidence"),
            "latency_ms": item.get("latency_ms"),
            "page_changed": item.get("page_changed"),
            "url": item.get("url"),
        })
    page = last.get("page") or {}
    result = {
        "ok": True,
        "provider": "jev-ultrafast",
        "status": last.get("status"),
        "elapsed_ms": last.get("elapsed_ms"),
        "target_id": getattr(agent.browser, "target", None),
        "url": page.get("url"),
        "title": page.get("title"),
        "steps": len(history),
        "history": history,
        "text_input": {
            "mode": "caller-supplied",
            "supplied_fields": len(input_values),
            "used": [
                {
                    "field": call.get("field"),
                    "source": call.get("model"),
                }
                for call in last.get("text_calls", [])
            ],
        },
        "requires_verification": last.get("status") == "done",
    }
    print(json.dumps(result, ensure_ascii=False))
finally:
    if not request.get("keep_open", True):
        agent.close()
`;
