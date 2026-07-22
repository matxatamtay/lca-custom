// Local Coding Agent TUI tests
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  TUI_SHORTCUTS,
  TUI_VIEWS,
  compactFacadeCall,
  dataFromToolResult,
  dashboardText,
  normalizeFileEntries,
  normalizeProcesses,
  normalizeSearchMatches,
  resolveBackendPath,
  safeJsonParse,
  viewByShortcut
} from "./tui/model.mjs";
import { LcaTuiApp } from "./tui/app.mjs";
import { LcaTuiClient } from "./tui/client.mjs";
import { launcherInvocation } from "./tui/launcher-bridge.mjs";
import { parseArgs, promoteProjectRoot } from "../scripts/local-coding-agent.mjs";

test("TUI ships every planned feature screen with unique shortcuts", () => {
  assert.equal(TUI_VIEWS.length, 16);
  assert.deepEqual(TUI_VIEWS.map((view) => view.id), [
    "dashboard", "projects", "files", "search", "context", "git", "commands", "processes",
    "verify", "tasks", "skills", "integrations", "memory", "tools", "logs", "help"
  ]);
  assert.equal(new Set(TUI_VIEWS.map((view) => view.id)).size, TUI_VIEWS.length);
  assert.equal(new Set(TUI_VIEWS.map((view) => view.key)).size, TUI_VIEWS.length);
  assert.ok(TUI_SHORTCUTS.some(([key]) => key === "Mouse"));
  assert.equal(viewByShortcut("g")?.id, "git");
  assert.equal(viewByShortcut("", "?")?.id, "help");
});

test("compact facade calls preserve the 14-tool public contract", () => {
  assert.deepEqual(compactFacadeCall("workspace_git", "status", { cwd: "/tmp/repo" }), {
    name: "workspace_git",
    arguments: { action: "status", arguments: { cwd: "/tmp/repo" } }
  });
  assert.deepEqual(compactFacadeCall("workspace_context", null, { task: "inspect" }), {
    name: "workspace_context",
    arguments: { task: "inspect" }
  });
});

test("tool result parsing prefers structured content and safely parses text JSON", () => {
  assert.deepEqual(dataFromToolResult({ structuredContent: { ok: true } }), { ok: true });
  assert.deepEqual(dataFromToolResult({ content: [{ type: "text", text: "{\"ok\":true}" }] }), { ok: true });
  assert.equal(dataFromToolResult({ content: [{ type: "text", text: "plain" }] }), "plain");
  assert.deepEqual(safeJsonParse("{\"action\":\"status\"}"), { action: "status" });
  assert.throws(() => safeJsonParse("{"), /Invalid JSON/);
});

test("file, search, and process rows are mouse-list ready", () => {
  const files = normalizeFileEntries({ entries: [
    { path: "/tmp/demo", type: "directory" },
    { path: "/tmp/demo/a.js", type: "file", size: 2048 }
  ] });
  assert.match(files[0].label, /demo/);
  assert.match(files[1].label, /2\.0 KB/);

  const matches = normalizeSearchMatches({ matches: [{ path: "src/a.js", line: 7, text: "needle" }] });
  assert.match(matches[0].label, /src\/a\.js:7/);

  const processes = normalizeProcesses({ processes: [{ id: "p1", name: "dev", status: "running", pid: 12, command: "npm run dev" }] });
  assert.match(processes[0].label, /● dev/);
});

test("backend paths resolve from the primary workspace without duplicating the current folder", () => {
  const root = path.resolve("/tmp/lca-root");
  assert.equal(resolveBackendPath(root, "evals/run.mjs"), path.join(root, "evals", "run.mjs"));
  assert.equal(resolveBackendPath(root, "/tmp/external.txt"), path.resolve("/tmp/external.txt"));
});

test("file and search row handlers round-trip backend paths from the primary workspace", async () => {
  const root = path.resolve("/tmp/lca-root");
  const reads = [];
  const app = Object.create(LcaTuiApp.prototype);
  app.primaryRoot = root;
  app.currentPath = path.join(root, "evals");
  app.searchRoot = app.currentPath;
  app.client = {
    async readFile(file, options) {
      reads.push({ file, options });
      return { content: "ok" };
    }
  };
  app.setDetail = () => {};

  await app.openFileRow({ path: "evals/run.mjs", type: "file" });
  await app.openSearchMatch({ path: "evals/run.mjs", line: 12 });

  assert.equal(reads[0].file, path.join(root, "evals", "run.mjs"));
  assert.equal(reads[1].file, path.join(root, "evals", "run.mjs"));
  assert.deepEqual(reads[1].options, { startLine: 1, lineCount: 80 });
});

test("TUI client routes all operations through compact facades", async () => {
  const calls = [];
  let closes = 0;
  const fake = {
    async listTools() { return { tools: [{ name: "workspace_git" }] }; },
    async callTool(input) {
      calls.push(input);
      return { content: [{ type: "text", text: "{\"ok\":true}" }] };
    },
    async close() { closes += 1; }
  };
  const client = new LcaTuiClient({ client: fake, endpoint: "http://127.0.0.1:1/mcp" });
  assert.deepEqual(await client.gitStatus("/tmp/repo"), { ok: true });
  assert.deepEqual(calls[0], {
    name: "workspace_git",
    arguments: { action: "status", arguments: { cwd: "/tmp/repo" } }
  });
  await client.context("inspect", "/tmp/repo");
  assert.equal(calls[1].name, "workspace_context");
  assert.equal(calls[1].arguments.task, "inspect");
  await client.verify("detect", "/tmp/other-repo");
  assert.deepEqual(calls[2], {
    name: "workspace_verify",
    arguments: { action: "detect", arguments: { path: "/tmp/other-repo" } }
  });
  await client.verify("tests", "/tmp/other-repo");
  assert.deepEqual(calls[3], {
    name: "workspace_verify",
    arguments: { action: "tests", arguments: { cwd: "/tmp/other-repo" } }
  });
  await client.notes(100);
  assert.deepEqual(calls[4], {
    name: "workspace_read",
    arguments: { action: "notes", arguments: { limit: 50 } }
  });
  await client.close();
  assert.equal(closes, 1);
});

test("launcher bridge keeps config path in environment instead of command arguments", () => {
  const spec = launcherInvocation("./scripts/local-coding-agent.mjs", ["primary", "/tmp/repo"], "./tmp/config.json");
  assert.equal(spec.command, process.execPath);
  assert.deepEqual(spec.args.slice(1), ["primary", "/tmp/repo"]);
  assert.equal(spec.env.LCA_CUSTOM_CONFIG_PATH, path.resolve("./tmp/config.json"));
  assert.doesNotMatch(spec.args.join(" "), /CONFIG_PATH/);
});

test("primary project promotion preserves every registered project", () => {
  const a = path.resolve("a");
  const b = path.resolve("b");
  const c = path.resolve("c");
  assert.deepEqual(promoteProjectRoot([a, b, c], b), [b, a, c]);
  assert.deepEqual(promoteProjectRoot([a, b], c), [c, a, b]);
});

test("CLI parser recognizes TUI and primary project commands", () => {
  assert.deepEqual(parseArgs(["tui"]), { command: "tui", rest: [], flags: {} });
  assert.deepEqual(parseArgs(["primary", "/tmp/repo"]), { command: "primary", rest: ["/tmp/repo"], flags: {} });
});

test("dashboard text includes runtime, integrations, and mouse guidance", () => {
  const text = dashboardText({
    health: { status: "ok", runtime: "trusted-local", tool_surface: "compact", version: "4.4.0-pro", pid: 1, workspace: "/tmp/repo" },
    info: { roots: ["/tmp/repo"] },
    doctor: { status: "pass", summary: { pass: 20, warn: 0, fail: 0 } },
    integrations: [{ name: "Figma", ok: true, detail: "connected" }],
    memory: { status: "healthy" },
    launcher: { pids: { tunnel: 2, tunnel_alive: true } }
  });
  assert.match(text, /trusted-local/);
  assert.match(text, /Figma/);
  assert.match(text, /Click a navigation item/);
});
