import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const serverDir = path.join(repoRoot, "server");
const serverEntry = path.join(serverDir, "server.mjs");
const baselinePath = path.join(here, "baseline.json");
const outputPath = path.join(here, "compact.json");

const sdkClientPath = path.join(serverDir, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "index.js");
const sdkHttpPath = path.join(serverDir, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "streamableHttp.js");
const compactInterfacePath = path.join(serverDir, "dist", "interfaces", "mcp", "compact-mcp-interface.js");
const { Client } = await import(pathToFileURL(sdkClientPath).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(sdkHttpPath).href);
const { COMPACT_SERVER_INSTRUCTIONS } = await import(pathToFileURL(compactInterfacePath).href);

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(port, stderr) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error(`Compact benchmark server failed to start.\n${stderr.value}`);
}

async function measure(operation, runs = 8) {
  await operation();
  const values = [];
  for (let index = 0; index < runs; index++) {
    const startedAt = performance.now();
    await operation();
    values.push(performance.now() - startedAt);
  }
  values.sort((a, b) => a - b);
  return {
    runs,
    min: round(values[0] ?? 0),
    median: round(values[Math.floor(values.length / 2)] ?? 0),
    max: round(values.at(-1) ?? 0)
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function percentReduction(before, after) {
  if (!before) return null;
  return round(((before - after) / before) * 100);
}

function currentCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function firstText(result) {
  return result?.content?.find((item) => item.type === "text")?.text || "";
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "lca-compact-bench-"));
const port = await getFreePort();
const stderr = { value: "" };
let child;
let client;

try {
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "# Compact benchmark workspace\n", "utf8");
  await writeFile(path.join(workspace, "src", "sample.js"), "export const sample = true;\n", "utf8");

  child = spawn(process.execPath, [serverEntry], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_HOST: "127.0.0.1",
      AGENT_WORKSPACE: workspace,
      AGENTMEMORY_RECORD_SESSIONS: "0",
      AGENT_AUDIT: "0",
      MCP_AUTH_TOKEN: ""
    },
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr?.on("data", (chunk) => {
    stderr.value += chunk.toString();
  });

  await waitForHealth(port, stderr);
  client = new Client({ name: "lca-compact-benchmark", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

  const listed = await client.listTools();
  const tools = listed.tools ?? [];
  const instructions = COMPACT_SERVER_INSTRUCTIONS;
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));

  const workspaceStatus = () => client.callTool({ name: "workspace_status", arguments: { action: "info" } });
  const workspaceRead = () => client.callTool({ name: "workspace_read", arguments: { action: "one", arguments: { path: "README.md", max_chars: 1000 } } });
  const statusProbe = await workspaceStatus();
  const status = JSON.parse(firstText(statusProbe));

  const report = {
    generatedAt: new Date().toISOString(),
    gitHead: currentCommit(),
    surface: status.tool_surface,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    toolSurface: {
      count: tools.length,
      jsonBytes: Buffer.byteLength(JSON.stringify(tools), "utf8"),
      nameChars: tools.reduce((sum, tool) => sum + tool.name.length, 0),
      descriptionChars: tools.reduce((sum, tool) => sum + String(tool.description ?? "").length, 0),
      schemaChars: tools.reduce((sum, tool) => sum + JSON.stringify(tool.inputSchema ?? {}).length, 0)
    },
    instructions: {
      chars: instructions.length,
      bytes: Buffer.byteLength(instructions, "utf8"),
      lines: instructions ? instructions.split("\n").length : 0
    },
    latencyMs: {
      listTools: await measure(() => client.listTools()),
      workspaceStatusWarm: await measure(workspaceStatus),
      workspaceReadWarm: await measure(workspaceRead)
    },
    improvementVsBaselinePercent: {
      toolCount: percentReduction(baseline.toolSurface.count, tools.length),
      toolSurfaceBytes: percentReduction(baseline.toolSurface.jsonBytes, Buffer.byteLength(JSON.stringify(tools), "utf8")),
      instructionChars: percentReduction(baseline.instructions.chars, instructions.length)
    },
    targets: {
      toolCountMax: 16,
      toolSurfaceBytesMax: 20_000,
      instructionCharsMax: 1_000
    }
  };

  if (report.toolSurface.count > report.targets.toolCountMax) throw new Error(`Tool count target missed: ${report.toolSurface.count}`);
  if (report.toolSurface.jsonBytes > report.targets.toolSurfaceBytesMax) throw new Error(`Tool schema target missed: ${report.toolSurface.jsonBytes}`);
  if (report.instructions.chars > report.targets.instructionCharsMax) throw new Error(`Instruction target missed: ${report.instructions.chars}`);

  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nCompact benchmark written to ${outputPath}`);
} finally {
  if (client) await client.close().catch(() => {});
  if (child?.pid) {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill("SIGTERM");
  }
  await wait(300);
  await rm(workspace, { recursive: true, force: true });
}
