#!/usr/bin/env node
// Local Coding Agent — mouse-enabled terminal UI
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runLcaTui } from "./tui/app.mjs";
import { LcaTuiClient } from "./tui/client.mjs";
import { LauncherBridge } from "./tui/launcher-bridge.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(process.env.LCA_TUI_REPO_ROOT || path.join(APP_DIR, ".."));
const CONFIG_PATH = process.env.LCA_TUI_CONFIG_PATH || "";
const CLI_SCRIPT = process.env.LCA_TUI_CLI_SCRIPT || path.join(REPO_ROOT, "scripts", "local-coding-agent.mjs");
const ENDPOINT = process.env.LCA_TUI_ENDPOINT || "http://127.0.0.1:8790/mcp";
const WORKSPACE = process.env.LCA_TUI_WORKSPACE || REPO_ROOT;
const SERVER_DATA = process.env.LCA_TUI_SERVER_DATA || path.join(APP_DIR, "data");

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("ERROR: lca-custom tui requires an interactive terminal.");
  process.exit(1);
}

const client = new LcaTuiClient({
  endpoint: ENDPOINT,
  authToken: process.env.LCA_TUI_AUTH_TOKEN || "",
  memoryUrl: process.env.AGENTMEMORY_URL || "http://127.0.0.1:3111",
  version: process.env.LCA_TUI_VERSION || "4.4.0-pro"
});
const launcher = new LauncherBridge({
  scriptPath: CLI_SCRIPT,
  cwd: REPO_ROOT,
  configPath: CONFIG_PATH
});

try {
  await runLcaTui({
    client,
    launcher,
    version: process.env.LCA_TUI_VERSION || "4.4.0-pro",
    repoRoot: REPO_ROOT,
    configPath: CONFIG_PATH || path.join(REPO_ROOT, "cli-config.json"),
    workspace: WORKSPACE,
    logPaths: {
      launcher: process.env.LCA_TUI_LAUNCHER_LOG || "",
      lifecycle: path.join(SERVER_DATA, "lifecycle.log"),
      audit: path.join(SERVER_DATA, "audit.log")
    }
  });
} catch (error) {
  try { await client.close(); } catch {}
  console.error(`ERROR: ${error?.stack || error}`);
  process.exit(1);
}
