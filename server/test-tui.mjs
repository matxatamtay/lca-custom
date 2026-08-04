// Local Coding Agent TUI tests
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
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
import {
  isSecretEnvKey,
  maskedEnvValue,
  mergeEnvText,
  parseEnvText,
  readEnvConfig,
  removeKeysFromEnvText,
  updateEnvConfig
} from "./tui/env-config.mjs";
import { LauncherBridge, launcherInvocation } from "./tui/launcher-bridge.mjs";
import { directoryPickerRows, nextPickerDirectory } from "./tui/folder-picker.mjs";
import { fuzzyFilter, fuzzyScore } from "./tui/palette.mjs";
import {
  closeResourceTab,
  createResourceTab,
  nextResourceTabId,
  normalizeResourceTabs,
  toggleResourceTabPinned,
  updateWorkspaceTabLocation,
  upsertResourceTab
} from "./tui/resource-tabs.mjs";
import {
  appendCommandHistory,
  commandHistoryScope,
  defaultTuiStatePath,
  loadTuiState,
  normalizePaneSplitPercent,
  normalizeViewOrder,
  reorderItems,
  saveTuiState
} from "./tui/state.mjs";
import { parseArgs, promoteProjectRoot } from "../scripts/local-coding-agent.mjs";

test("TUI ships every planned feature screen with unique shortcuts", () => {
  assert.equal(TUI_VIEWS.length, 17);
  assert.deepEqual(TUI_VIEWS.map((view) => view.id), [
    "dashboard", "projects", "files", "search", "context", "git", "commands", "processes",
    "verify", "tasks", "skills", "integrations", "config", "memory", "tools", "logs", "help"
  ]);
  assert.equal(new Set(TUI_VIEWS.map((view) => view.id)).size, TUI_VIEWS.length);
  assert.equal(new Set(TUI_VIEWS.map((view) => view.key)).size, TUI_VIEWS.length);
  assert.ok(TUI_SHORTCUTS.some(([key]) => key === "Mouse"));
  assert.equal(viewByShortcut("g")?.id, "git");
  assert.equal(viewByShortcut("", "?")?.id, "help");
});

test("tab order can be normalized, reordered, and persisted", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lca-tui-state-"));
  const project = path.join(root, "project");
  mkdirSync(project);
  const configPath = path.join(root, "config", "cli-config.json");
  mkdirSync(path.dirname(configPath), { recursive: true });
  const statePath = defaultTuiStatePath(configPath);
  try {
    assert.deepEqual(normalizeViewOrder(["dashboard", "projects", "files"], ["files", "files", "unknown"]), [
      "files", "dashboard", "projects"
    ]);
    assert.deepEqual(reorderItems(["dashboard", "projects", "files"], 0, 2), ["projects", "files", "dashboard"]);
    saveTuiState(statePath, {
      active_view: "files",
      view_order: ["files", "dashboard", "projects"],
      recent_directories: [project],
      last_directory: project,
      pane_split_percent: 57,
      resource_tabs: [createResourceTab("workspace", project, { pinned: true })],
      active_resource_tab: `workspace:${project}`,
      command_histories: {
        [project]: [{ command: "git status", cwd: project, ok: true, output: "clean", created_at: "2026-07-27T00:00:00.000Z" }]
      }
    });
    const loaded = loadTuiState(statePath, {
      allViewIds: ["dashboard", "projects", "files"],
      fallbackWorkspace: project,
      recentDirectories: [root]
    });
    assert.equal(loaded.active_view, "files");
    assert.deepEqual(loaded.view_order, ["files", "dashboard", "projects"]);
    assert.equal(loaded.last_directory, project);
    assert.deepEqual(loaded.recent_directories.slice(0, 2), [project, root]);
    assert.equal(loaded.pane_split_percent, 57);
    assert.equal(loaded.resource_tabs[0].pinned, true);
    assert.equal(loaded.command_histories[project][0].command, "git status");
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).schema, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace and file tabs support pin, close, switching, and directory state", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lca-resource-tabs-"));
  const nested = path.join(root, "nested");
  const file = path.join(nested, "index.mjs");
  mkdirSync(nested);
  writeFileSync(file, "export default true;\n");
  try {
    const workspace = createResourceTab("workspace", root, { current_path: nested });
    const sourceFile = createResourceTab("file", file);
    let tabs = normalizeResourceTabs([workspace, sourceFile], root);
    assert.equal(tabs.length, 2);
    assert.equal(tabs[0].current_path, nested);
    tabs = upsertResourceTab(tabs, { ...sourceFile, pinned: true });
    assert.equal(tabs[0].id, sourceFile.id);
    assert.equal(tabs[0].pinned, true);
    assert.equal(closeResourceTab(tabs, sourceFile.id, root).reason, "pinned");
    tabs = toggleResourceTabPinned(tabs, sourceFile.id);
    assert.equal(tabs.find((tab) => tab.id === sourceFile.id).pinned, false);
    tabs = updateWorkspaceTabLocation(tabs, workspace.id, root);
    assert.equal(tabs.find((tab) => tab.id === workspace.id).current_path, root);
    assert.equal(nextResourceTabId(tabs, workspace.id, 1), sourceFile.id);
    const closed = closeResourceTab(tabs, sourceFile.id, root);
    assert.equal(closed.closed, true);
    assert.equal(closed.tabs.some((tab) => tab.kind === "workspace"), true);

    const extraFiles = ["one.js", "two.js", "three.js"].map((name) => path.join(nested, name));
    for (const extra of extraFiles) writeFileSync(extra, "// tab\n");
    let bounded = [createResourceTab("workspace", root, { pinned: true })];
    for (const extra of extraFiles) bounded = upsertResourceTab(bounded, createResourceTab("file", extra), 3);
    assert.equal(bounded.length, 3);
    assert.equal(bounded.some((tab) => tab.kind === "workspace" && tab.pinned), true);
    assert.equal(bounded.some((tab) => tab.path === extraFiles.at(-1)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fuzzy command palette ranks direct and boundary matches", () => {
  const items = [
    { label: "Start managed runtime", searchText: "start managed runtime server" },
    { label: "Browse local folder", searchText: "browse local folder directory" },
    { label: "Build mandatory context", searchText: "build mandatory context codegraph" }
  ];
  assert.ok(fuzzyScore("browse local folder", "brlf") > fuzzyScore("build mandatory context", "brlf"));
  assert.deepEqual(fuzzyFilter(items, "folder").map((item) => item.label), ["Browse local folder"]);
  assert.equal(fuzzyFilter(items, "bmc")[0].label, "Build mandatory context");
});

test("pane split and command history stay bounded per project", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lca-command-history-"));
  const projectA = path.join(root, "a");
  const projectB = path.join(root, "b");
  mkdirSync(projectA);
  mkdirSync(projectB);
  try {
    assert.equal(normalizePaneSplitPercent(5), 22);
    assert.equal(normalizePaneSplitPercent(99), 76);
    assert.equal(commandHistoryScope(projectA), projectA);
    let histories = appendCommandHistory({}, projectA, { command: "npm test", cwd: projectA, ok: true, output: "pass" }, { maxEntries: 2 });
    histories = appendCommandHistory(histories, projectA, { command: "npm run build", cwd: projectA, ok: true, output: "built" }, { maxEntries: 2 });
    histories = appendCommandHistory(histories, projectA, { command: "git status", cwd: projectA, ok: true, output: "clean" }, { maxEntries: 2 });
    histories = appendCommandHistory(histories, projectB, { command: "cargo test", cwd: projectB, ok: false, output: "failed" }, { maxEntries: 2 });
    assert.deepEqual(histories[projectA].map((item) => item.command), ["npm run build", "git status"]);
    assert.deepEqual(histories[projectB].map((item) => item.command), ["cargo test"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("folder picker lists only directories with parent, recent, and select actions", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lca-folder-picker-"));
  const alpha = path.join(root, "alpha");
  const beta = path.join(root, "beta2");
  const recent = path.join(root, "recent");
  mkdirSync(alpha);
  mkdirSync(beta);
  mkdirSync(recent);
  writeFileSync(path.join(root, "file.txt"), "not a directory");
  try {
    const rows = await directoryPickerRows(root, { recentDirectories: [recent] });
    assert.equal(rows[0].kind, "select");
    assert.equal(rows[0].path, root);
    assert.ok(rows.some((row) => row.kind === "parent"));
    assert.ok(rows.some((row) => row.kind === "recent" && row.path === recent));
    assert.deepEqual(rows.filter((row) => row.kind === "directory").map((row) => row.name), ["alpha", "beta2", "recent"]);
    assert.equal(rows.some((row) => row.label.includes("file.txt")), false);
    assert.equal(nextPickerDirectory(rows.find((row) => row.name === "alpha"), root), alpha);
    assert.equal(nextPickerDirectory(rows[0], root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mouse drag state reorders tabs live and persists the new order", () => {
  const app = Object.create(LcaTuiApp.prototype);
  app.views = [
    { id: "dashboard" },
    { id: "projects" },
    { id: "files" }
  ];
  app.navDrag = { source: 1, current: 1, target: 1, moved: false, viewId: "projects" };
  let rendered = 0;
  let persisted = 0;
  app.renderNavTabs = () => { rendered += 1; };
  app.persistUiState = () => { persisted += 1; };

  app.updateNavDrag(2);

  assert.deepEqual(app.views.map((view) => view.id), ["dashboard", "files", "projects"]);
  assert.equal(app.navDrag.current, 2);
  assert.equal(app.navDrag.moved, true);
  assert.equal(rendered, 1);
  assert.equal(persisted, 1);
});

test("project add flow uses the folder picker instead of a typed path", async () => {
  const picked = path.resolve("/tmp/lca-picked-project");
  const calls = [];
  const app = Object.create(LcaTuiApp.prototype);
  app.primaryRoot = path.resolve("/tmp/current-project");
  app.pickDirectory = async (title, initial) => {
    calls.push({ type: "pick", title, initial });
    return picked;
  };
  app.rememberDirectory = (directory) => calls.push({ type: "remember", directory });
  app.launcher = {
    async addProject(project) {
      calls.push({ type: "add", project });
      return { code: 0, stdout: "ok", stderr: "" };
    }
  };
  app.client = { async close() { calls.push({ type: "close" }); } };
  app.refreshProjects = async () => { calls.push({ type: "refresh" }); };

  await app.addProject();

  assert.deepEqual(calls, [
    { type: "pick", title: "Add project", initial: app.primaryRoot },
    { type: "remember", directory: picked },
    { type: "add", project: picked },
    { type: "close" },
    { type: "refresh" }
  ]);
});

test("compact facade calls preserve the compact public contract", () => {
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

test("file and search row handlers open resource tabs with primary-root paths", async () => {
  const root = path.resolve("/tmp/lca-root");
  const reads = [];
  const opened = [];
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
  app.openFileTab = (file) => { opened.push(file); };
  app.refreshFiles = async () => {};
  app.setDetail = () => {};

  await app.openFileRow({ path: "evals/run.mjs", type: "file" });
  await app.openSearchMatch({ path: "evals/run.mjs", line: 12 });

  assert.deepEqual(opened, [path.join(root, "evals", "run.mjs"), path.join(root, "evals", "run.mjs")]);
  assert.equal(reads[0].file, path.join(root, "evals", "run.mjs"));
  assert.deepEqual(reads[0].options, { startLine: 1, lineCount: 80 });
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

test("env config preserves comments, masks secrets, and writes mode 600", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lca-env-config-"));
  const envPath = path.join(root, ".env.local");
  try {
    const initial = "# integrations\nBRUNO_DESKTOP_MCP_URL=http://127.0.0.1:3847/mcp\nBRUNO_DESKTOP_AUTH_TOKEN=first-test-token\n";
    const parsed = parseEnvText(initial);
    assert.equal(parsed.values.BRUNO_DESKTOP_AUTH_TOKEN, "first-test-token");
    assert.equal(isSecretEnvKey("BRUNO_DESKTOP_AUTH_TOKEN"), true);
    assert.equal(isSecretEnvKey("PENPOT_USER_TOKEN"), true);
    assert.equal(maskedEnvValue("BRUNO_DESKTOP_AUTH_TOKEN", "first-test-token"), "••••••");
    assert.equal(maskedEnvValue("PENPOT_USER_TOKEN", "penpot-test-token"), "••••••");
    assert.equal(maskedEnvValue("BRUNO_DESKTOP_MCP_URL", "http://127.0.0.1:3847/mcp"), "http://127.0.0.1:3847/mcp");

    const merged = mergeEnvText(initial, {
      BRUNO_DESKTOP_AUTH_TOKEN: "second test token",
      COOLIFY_BASE_URL: "https://coolify.example.test"
    });
    assert.match(merged, /^# integrations/m);
    assert.match(merged, /BRUNO_DESKTOP_AUTH_TOKEN="second test token"/);
    assert.match(merged, /COOLIFY_BASE_URL=https:\/\/coolify\.example\.test/);
    assert.doesNotMatch(removeKeysFromEnvText(merged, ["BRUNO_DESKTOP_AUTH_TOKEN"]), /BRUNO_DESKTOP_AUTH_TOKEN/);

    writeFileSync(envPath, initial);
    await updateEnvConfig(envPath, { BRUNO_DESKTOP_AUTH_TOKEN: "updated-test-token" });
    const config = await readEnvConfig(envPath);
    assert.equal(config.values.BRUNO_DESKTOP_AUTH_TOKEN, "updated-test-token");
    if (process.platform !== "win32") assert.equal(statSync(envPath).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launcher reloads the latest .env.local values before every command", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lca-launcher-env-"));
  const scriptPath = path.join(root, "print-env.mjs");
  const envPath = path.join(root, ".env.local");
  try {
    writeFileSync(scriptPath, "process.stdout.write(process.env.BRUNO_DESKTOP_AUTH_TOKEN || 'missing');\n");
    writeFileSync(envPath, "BRUNO_DESKTOP_AUTH_TOKEN=first-test-token\n");
    const launcher = new LauncherBridge({
      scriptPath,
      cwd: root,
      envPath,
      env: { BRUNO_DESKTOP_AUTH_TOKEN: "stale-process-token" },
      managedEnvKeys: ["BRUNO_DESKTOP_AUTH_TOKEN"]
    });
    const first = await launcher.run([]);
    assert.equal(first.code, 0);
    assert.equal(first.stdout, "first-test-token");

    await updateEnvConfig(envPath, { BRUNO_DESKTOP_AUTH_TOKEN: "second-test-token" });
    const second = await launcher.run([]);
    assert.equal(second.code, 0);
    assert.equal(second.stdout, "second-test-token");

    writeFileSync(envPath, "");
    const third = await launcher.run([]);
    assert.equal(third.code, 0);
    assert.equal(third.stdout, "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
