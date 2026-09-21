// Local Coding Agent TUI — mouse-enabled terminal application
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import os from "node:os";
import path from "node:path";

import blessed from "neo-blessed";

import { directoryPickerRows, nextPickerDirectory } from "./folder-picker.mjs";
import { fuzzyFilter } from "./palette.mjs";
import { THEME } from "./theme.mjs";
import {
  escapeTags, fileContent, integrationSummary, isOfflineResult, modalButton, providerIcon,
  renderData, resolveAgainst
} from "./view-helpers.mjs";
import { TuiShellMethods } from "./shell-methods.mjs";
import { TuiTabMethods } from "./tab-methods.mjs";
import { TuiWorkspaceViewMethods } from "./workspace-view-methods.mjs";
import { TuiOperationViewMethods } from "./operation-view-methods.mjs";
import { TuiDialogMethods } from "./dialog-methods.mjs";
import {
  closeResourceTab,
  createResourceTab,
  nextResourceTabId,
  toggleResourceTabPinned,
  updateWorkspaceTabLocation,
  upsertResourceTab
} from "./resource-tabs.mjs";
import {
  appendCommandHistory,
  commandHistoryScope,
  defaultTuiStatePath,
  loadTuiState,
  normalizePaneSplitPercent,
  normalizeViewOrder,
  reorderItems,
  saveTuiState
} from "./state.mjs";

import {
  TUI_SHORTCUTS,
  TUI_VIEWS,
  compactPath,
  dashboardText,
  dataFromToolResult,
  formatBytes,
  formatDuration,
  formatToolResult,
  normalizeFileEntries,
  normalizeGitRows,
  normalizeProcesses,
  normalizeSearchMatches,
  normalizeSkills,
  resolveBackendPath,
  safeJsonParse,
  selectedRow,
  textFromToolResult,
  viewByShortcut
} from "./model.mjs";


export class LcaTuiApp {
  constructor(options) {
    this.client = options.client;
    this.launcher = options.launcher;
    this.version = options.version || "4.4.0-pro";
    this.repoRoot = path.resolve(options.repoRoot);
    this.configPath = path.resolve(options.configPath);
    this.statePath = path.resolve(options.statePath || defaultTuiStatePath(this.configPath));
    this.logPaths = options.logPaths || {};
    this.primaryRoot = path.resolve(options.workspace || this.repoRoot);
    const storedState = loadTuiState(this.statePath, {
      allViewIds: TUI_VIEWS.map((view) => view.id),
      fallbackWorkspace: this.primaryRoot,
      recentDirectories: [this.primaryRoot, this.repoRoot, process.cwd()].filter(Boolean)
    });
    this.views = storedState.view_order
      .map((id) => TUI_VIEWS.find((view) => view.id === id))
      .filter(Boolean);
    this.recentDirectories = storedState.recent_directories;
    this.activeView = this.views.some((view) => view.id === storedState.active_view) ? storedState.active_view : "dashboard";
    this.currentPath = path.resolve(storedState.last_directory || this.primaryRoot);
    this.searchRoot = this.primaryRoot;
    this.gitRoot = this.primaryRoot;
    this.paneSplitPercent = normalizePaneSplitPercent(storedState.pane_split_percent);
    this.paneDragging = false;
    this.resourceTabs = storedState.resource_tabs;
    this.activeResourceTabId = storedState.active_resource_tab;
    this.resourceTabButtons = [];
    this.commandHistories = storedState.command_histories;
    this.rows = [];
    this.rowHandler = null;
    this.actionButtons = [];
    this.actionShortcuts = new Map();
    this.lastSearch = "";
    this.searchRegex = false;
    this.lastContextTask = "";
    this.lastContext = null;
    this.lastCommandResult = "";
    this.lastLogPath = this.logPaths.launcher || "";
    this.memoryBackupDir = path.join(path.dirname(this.configPath), "agentmemory-backups");
    this.modalOpen = false;
    this.busyDepth = 0;
    this.closed = false;
    this.refreshTimer = null;
    this.focusIndex = 0;
    this.ignoreNextListSelect = false;
    this.navDrag = null;
    this.navClickGuardUntil = 0;
    this.suppressNextNavSelect = false;

    this.screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      dockBorders: true,
      title: "Local Coding Agent",
      cursor: { artificial: true, shape: "line", blink: true, color: THEME.accent },
      warnings: false
    });
    this.screen.program.enableMouse?.();

    this.buildLayout();
    this.bindGlobalKeys();
  }

  async run() {
    this.nav.select(Math.max(0, this.views.findIndex((view) => view.id === this.activeView)));
    this.nav.focus();
    this.updateHeader({ status: "connecting" });
    this.screen.render();
    await this.switchView(this.activeView);
    this.refreshTimer = setInterval(() => void this.refreshHeader(), 10_000);
    this.refreshTimer.unref?.();
    await new Promise((resolve) => { this.resolveClose = resolve; });
  }

  selected() {
    return selectedRow(this.rows, this.list.selected);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.refreshTimer);
    await this.client.close().catch(() => undefined);
    this.screen.destroy();
    this.resolveClose?.();
  }
}

for (const mixin of [TuiShellMethods, TuiTabMethods, TuiWorkspaceViewMethods, TuiOperationViewMethods, TuiDialogMethods]) {
  for (const name of Object.getOwnPropertyNames(mixin.prototype)) {
    if (name === "constructor") continue;
    Object.defineProperty(LcaTuiApp.prototype, name, Object.getOwnPropertyDescriptor(mixin.prototype, name));
  }
}

export async function runLcaTui(options) {
  const app = new LcaTuiApp(options);
  await app.run();
}
