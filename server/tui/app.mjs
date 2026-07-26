// Local Coding Agent TUI — mouse-enabled terminal application
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import os from "node:os";
import path from "node:path";

import blessed from "neo-blessed";

import { directoryPickerRows, nextPickerDirectory } from "./folder-picker.mjs";
import {
  defaultTuiStatePath,
  loadTuiState,
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

const THEME = Object.freeze({
  bg: "#0b1020",
  panel: "#11182b",
  panelAlt: "#151e34",
  border: "#34425f",
  accent: "#7dd3fc",
  accent2: "#a7f3d0",
  text: "#e5e7eb",
  muted: "#94a3b8",
  danger: "#fca5a5",
  warning: "#fde68a"
});

export class LcaTuiApp {
  constructor(options) {
    this.client = options.client;
    this.launcher = options.launcher;
    this.version = options.version || "4.4.0-pro";
    this.repoRoot = path.resolve(options.repoRoot);
    this.configPath = path.resolve(options.configPath);
    this.statePath = path.resolve(options.statePath || defaultTuiStatePath(this.configPath));
    this.logPaths = options.logPaths || {};
    const storedState = loadTuiState(this.statePath, {
      allViewIds: TUI_VIEWS.map((view) => view.id),
      recentDirectories: [options.workspace, this.repoRoot, process.cwd()].filter(Boolean)
    });
    this.views = storedState.view_order
      .map((id) => TUI_VIEWS.find((view) => view.id === id))
      .filter(Boolean);
    this.recentDirectories = storedState.recent_directories;
    this.activeView = this.views.some((view) => view.id === storedState.active_view) ? storedState.active_view : "dashboard";
    this.primaryRoot = path.resolve(options.workspace || this.repoRoot);
    this.currentPath = path.resolve(storedState.last_directory || this.primaryRoot);
    this.searchRoot = this.primaryRoot;
    this.gitRoot = this.primaryRoot;
    this.rows = [];
    this.rowHandler = null;
    this.actionButtons = [];
    this.actionShortcuts = new Map();
    this.commandHistory = [];
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

  buildLayout() {
    this.header = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      right: 0,
      height: 3,
      tags: true,
      padding: { left: 1, right: 1 },
      style: { bg: THEME.panelAlt, fg: THEME.text },
      content: " {bold}LCA{/bold}  starting…"
    });

    this.nav = blessed.list({
      parent: this.screen,
      top: 3,
      left: 0,
      width: 24,
      bottom: 2,
      label: " Tabs · drag to reorder ",
      border: { type: "line" },
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      items: this.views.map((view) => `${view.icon}  ${view.label}  {gray-fg}${view.key}{/gray-fg}`),
      scrollbar: { ch: "▐", track: { bg: THEME.panel }, style: { bg: THEME.accent } },
      style: {
        bg: THEME.panel,
        fg: THEME.text,
        border: { fg: THEME.border },
        selected: { bg: THEME.accent, fg: "black", bold: true },
        item: { hover: { bg: THEME.panelAlt, fg: THEME.accent } },
        label: { fg: THEME.accent }
      }
    });

    this.main = blessed.box({
      parent: this.screen,
      top: 3,
      left: 24,
      right: 0,
      bottom: 2,
      style: { bg: THEME.bg }
    });

    this.actionBar = blessed.box({
      parent: this.main,
      top: 0,
      left: 0,
      right: 0,
      height: 3,
      border: { type: "line" },
      label: " Actions ",
      style: { bg: THEME.panelAlt, border: { fg: THEME.border }, label: { fg: THEME.accent } }
    });

    this.list = blessed.list({
      parent: this.main,
      top: 3,
      left: 0,
      width: "40%",
      bottom: 0,
      label: " Items ",
      border: { type: "line" },
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: "▐", track: { bg: THEME.panel }, style: { bg: THEME.accent } },
      style: {
        bg: THEME.panel,
        fg: THEME.text,
        border: { fg: THEME.border },
        selected: { bg: THEME.accent, fg: "black", bold: true },
        item: { hover: { bg: THEME.panelAlt, fg: THEME.accent } },
        label: { fg: THEME.accent2 }
      }
    });

    this.detail = blessed.box({
      parent: this.main,
      top: 3,
      left: "40%",
      right: 0,
      bottom: 0,
      label: " Detail ",
      border: { type: "line" },
      padding: { left: 1, right: 1 },
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: "▐", track: { bg: THEME.panel }, style: { bg: THEME.accent } },
      style: {
        bg: THEME.bg,
        fg: THEME.text,
        border: { fg: THEME.border },
        label: { fg: THEME.accent2 }
      }
    });

    this.footer = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      right: 0,
      height: 2,
      tags: true,
      padding: { left: 1, right: 1 },
      style: { bg: THEME.panelAlt, fg: THEME.muted },
      content: " q quit   r refresh   Ctrl+P palette   Ctrl+B folders   drag tabs   ? help"
    });

    this.nav.on("select", (_item, index) => {
      if (this.suppressNextNavSelect) {
        this.suppressNextNavSelect = false;
        return;
      }
      const view = this.views[index];
      if (view) void this.switchView(view.id);
    });
    this.bindNavTabHandlers();
    this.list.on("select", (_item, index) => {
      if (this.ignoreNextListSelect) {
        this.ignoreNextListSelect = false;
        return;
      }
      void this.handleRow(index);
    });
    this.list.on("select item", (_item, index) => this.updateSelectedRow(index));
    this.list.on("keypress", () => this.updateSelectedRow(this.list.selected));
    this.screen.on("mousemove", (data) => {
      const index = this.navIndexFromMouse(data);
      if (index >= 0) this.updateNavDrag(index);
    });
    this.screen.on("mouseup", (data) => {
      if (!this.navDrag) return;
      const index = this.navIndexFromMouse(data);
      this.finishNavDrag(index >= 0 ? index : this.navDrag.target);
    });
    this.screen.program.on("mouse", (data) => {
      if (!this.navDrag) return;
      const index = this.navIndexFromMouse(data);
      if (data.action === "mousemove" && index >= 0) this.updateNavDrag(index);
      if (data.action === "mouseup") this.finishNavDrag(index >= 0 ? index : this.navDrag.target);
    });
  }

  bindGlobalKeys() {
    this.screen.key(["q", "C-c"], () => {
      if (this.modalOpen) return;
      void this.close();
    });
    this.screen.key(["r"], () => {
      if (!this.modalOpen) void this.refreshActiveView();
    });
    this.screen.key(["C-p"], () => {
      if (!this.modalOpen) void this.showPalette();
    });
    this.screen.key(["?"], () => {
      if (!this.modalOpen) void this.switchView("help");
    });
    this.screen.key(["tab"], () => {
      if (!this.modalOpen) this.cycleFocus(1);
    });
    this.screen.key(["S-tab"], () => {
      if (!this.modalOpen) this.cycleFocus(-1);
    });
    this.screen.key(["M-up"], () => {
      if (!this.modalOpen) this.moveActiveTab(-1);
    });
    this.screen.key(["M-down"], () => {
      if (!this.modalOpen) this.moveActiveTab(1);
    });
    this.screen.key(["C-b"], () => {
      if (!this.modalOpen) void this.browseFolder();
    });
    this.screen.on("keypress", (character, key = {}) => {
      if (this.modalOpen) return;
      const candidates = [character, key.full, key.sequence, key.name]
        .filter((value) => typeof value === "string" && value.length > 0);
      for (const candidate of candidates) {
        const action = this.actionShortcuts.get(candidate);
        if (!action) continue;
        void this.runBusy(action.label, action.handler);
        break;
      }
    });
    for (const view of TUI_VIEWS) {
      if (view.key === "/") continue;
      this.screen.key([view.key], () => {
        if (!this.modalOpen) void this.switchView(view.id);
      });
    }
    this.screen.key(["/"], () => {
      if (!this.modalOpen) void this.switchView("search").then(() => this.askSearch());
    });
  }

  cycleFocus(direction) {
    const focusable = [this.nav, ...this.actionButtons, ...(this.list.hidden ? [] : [this.list]), this.detail].filter((item) => !item.hidden);
    if (!focusable.length) return;
    const current = focusable.indexOf(this.screen.focused);
    this.focusIndex = current >= 0 ? current : this.focusIndex;
    this.focusIndex = (this.focusIndex + direction + focusable.length) % focusable.length;
    focusable[this.focusIndex].focus();
    this.screen.render();
  }

  async switchView(id) {
    const index = this.views.findIndex((view) => view.id === id);
    if (index < 0) return;
    const view = this.views[index];
    this.activeView = id;
    this.persistUiState();
    this.suppressNextNavSelect = true;
    this.nav.select(index);
    setImmediate(() => { this.suppressNextNavSelect = false; });
    this.footer.setContent(` {bold}${view.label}{/bold}   q quit   r refresh   Ctrl+P palette   Ctrl+B browse   Alt+↑/↓ move tab`);
    this.setStatus(`Loading ${view.label}…`);
    await this.refreshActiveView();
  }

  async refreshActiveView() {
    const renderers = {
      dashboard: () => this.refreshDashboard(),
      projects: () => this.refreshProjects(),
      files: () => this.refreshFiles(),
      search: () => this.refreshSearch(),
      context: () => this.refreshContext(),
      git: () => this.refreshGit(),
      commands: () => this.refreshCommands(),
      processes: () => this.refreshProcesses(),
      verify: () => this.refreshVerify(),
      tasks: () => this.refreshTasks(),
      skills: () => this.refreshSkills(),
      integrations: () => this.refreshIntegrations(),
      memory: () => this.refreshMemory(),
      tools: () => this.refreshTools(),
      logs: () => this.refreshLogs(),
      help: () => this.refreshHelp()
    };
    const renderer = renderers[this.activeView];
    if (!renderer) return;
    await this.runBusy(`Refreshing ${this.activeView}`, renderer);
  }

  async runBusy(label, operation) {
    const outermost = this.busyDepth === 0;
    this.busyDepth += 1;
    if (outermost) this.setStatus(`${label}…`);
    try {
      await operation();
      if (outermost) {
        this.setStatus("Ready");
        await this.refreshHeader();
      }
    } catch (error) {
      this.setStatus(`Error: ${error.message}`, true);
      this.setDetail("Error", error.stack || error.message, { raw: true });
    } finally {
      this.busyDepth = Math.max(0, this.busyDepth - 1);
      this.screen.render();
    }
  }

  async refreshHeader() {
    if (this.closed) return;
    try {
      const health = await this.client.health();
      this.primaryRoot = path.resolve(health.workspace || health.roots?.[0] || this.primaryRoot);
      this.updateHeader(health);
    } catch {
      this.updateHeader({ status: "offline" });
    }
  }

  updateHeader(health = {}) {
    const online = health.status === "ok";
    const project = compactPath(health.workspace || this.primaryRoot, Math.max(24, (this.screen.width || 100) - 68));
    this.header.setContent(
      ` {bold}{cyan-fg}LCA{/cyan-fg}{/bold} ${this.version}  ${online ? "{green-fg}● online{/green-fg}" : "{red-fg}○ offline{/red-fg}"}` +
      `  ${health.runtime || "trusted-local"}/${health.tool_surface || "compact"}` +
      `  pid=${health.pid ?? "-"}  {gray-fg}${escapeTags(project)}{/gray-fg}`
    );
    this.screen.render();
  }

  setStatus(message, error = false) {
    const color = error ? "red-fg" : "gray-fg";
    this.footer.setContent(` {${color}}${escapeTags(message)}{/${color}}   q quit   r refresh   Ctrl+P palette   Ctrl+B folders   ? help`);
    this.screen.render();
  }

  setActions(actions) {
    for (const button of this.actionButtons) button.destroy();
    this.actionButtons = [];
    this.actionShortcuts.clear();
    let left = 1;
    for (const action of actions) {
      const label = action.key ? `${action.label} [${action.key}]` : action.label;
      const width = Math.max(8, label.length + 2);
      const button = blessed.button({
        parent: this.actionBar,
        top: 0,
        left,
        width,
        height: 1,
        mouse: true,
        keys: true,
        shrink: true,
        content: ` ${label} `,
        style: {
          bg: THEME.border,
          fg: THEME.text,
          focus: { bg: THEME.accent, fg: "black", bold: true },
          hover: { bg: THEME.accent2, fg: "black" }
        }
      });
      button.on("press", () => void this.runBusy(action.label, action.handler));
      if (action.key) this.actionShortcuts.set(action.key, action);
      this.actionButtons.push(button);
      left += width + 1;
      if (left > (this.screen.width || 120) - 30) break;
    }
    this.screen.render();
  }

  showSplit(label = "Items") {
    this.list.show();
    this.list.setLabel(` ${label} `);
    this.list.width = "40%";
    this.detail.left = "40%";
    this.detail.width = undefined;
    this.detail.right = 0;
  }

  showDetailOnly() {
    this.list.hide();
    this.detail.left = 0;
    this.detail.right = 0;
    this.detail.width = undefined;
  }

  setRows(rows, handler = null, label = "Items") {
    this.showSplit(label);
    this.rows = Array.isArray(rows) ? rows : [];
    this.rowHandler = handler;
    this.list.setItems(this.rows.map((row) => escapeTags(row.label ?? String(row))));
    this.attachSingleClickHandlers(this.list, (index) => this.handleRow(index));
    if (this.rows.length) this.list.select(0);
    this.screen.render();
  }

  attachSingleClickHandlers(list, handler) {
    for (const [index, item] of (list.items || []).entries()) {
      item.on("mousedown", () => {
        this.ignoreNextListSelect = true;
        list.select(index);
        list.focus();
        this.screen.render();
        void Promise.resolve(handler(index)).finally(() => {
          setImmediate(() => { this.ignoreNextListSelect = false; });
        });
      });
    }
  }

  navIndexFromMouse(data) {
    const position = this.nav.lpos;
    if (!position || !Number.isFinite(data?.x) || !Number.isFinite(data?.y)) return -1;
    if (data.x <= position.xi || data.x >= position.xl || data.y <= position.yi || data.y >= position.yl) return -1;
    const row = data.y - position.yi - 1 + (this.nav.childBase || 0);
    return row >= 0 && row < this.views.length ? row : -1;
  }

  bindNavTabHandlers() {
    for (const [index, item] of (this.nav.items || []).entries()) {
      item.on("mousedown", () => {
        if (this.navDrag && this.navDrag.current !== index) {
          this.updateNavDrag(index);
          return;
        }
        this.navDrag = { source: index, current: index, target: index, moved: false, viewId: this.views[index]?.id };
        this.suppressNextNavSelect = true;
        this.nav.select(index);
        this.nav.focus();
        this.nav.setLabel(" Tabs · release to drop ");
        const view = this.views[index];
        if (view && view.id !== this.activeView) void this.switchView(view.id);
        this.screen.render();
      });
      item.on("mouseover", () => this.updateNavDrag(index));
      item.on("mousemove", () => this.updateNavDrag(index));
      item.on("click", () => {
        if (Date.now() < this.navClickGuardUntil) return;
        if (this.navDrag) {
          this.finishNavDrag(this.navDrag.target);
          return;
        }
        const view = this.views[index];
        if (view) void this.switchView(view.id);
      });
    }
  }

  updateNavDrag(targetIndex) {
    if (!this.navDrag || targetIndex < 0 || targetIndex >= this.views.length) return;
    const currentIndex = this.navDrag.current;
    this.navDrag.target = targetIndex;
    if (currentIndex !== targetIndex) {
      this.views = reorderItems(this.views, currentIndex, targetIndex);
      this.navDrag.current = targetIndex;
      this.navDrag.moved = true;
      this.renderNavTabs();
      this.persistUiState();
    } else {
      this.suppressNextNavSelect = true;
      this.nav.select(targetIndex);
      this.screen.render();
    }
  }

  finishNavDrag() {
    if (!this.navDrag) return;
    const drag = this.navDrag;
    this.navDrag = null;
    this.navClickGuardUntil = Date.now() + 120;
    this.nav.setLabel(" Tabs · drag to reorder ");
    if (drag.moved) {
      this.persistUiState();
      this.setStatus(`Moved tab to position ${Math.max(1, drag.current + 1)}`);
    } else if (drag.viewId) {
      void this.switchView(drag.viewId);
    }
    setImmediate(() => { this.suppressNextNavSelect = false; });
  }

  reorderViewTabs(sourceIndex, targetIndex) {
    this.views = reorderItems(this.views, sourceIndex, targetIndex);
    this.renderNavTabs();
    this.persistUiState();
    this.setStatus(`Moved tab to position ${Math.max(1, targetIndex + 1)}`);
  }

  moveActiveTab(direction) {
    const source = this.views.findIndex((view) => view.id === this.activeView);
    if (source < 0) return;
    const target = Math.max(0, Math.min(this.views.length - 1, source + direction));
    if (source === target) return;
    this.reorderViewTabs(source, target);
    this.nav.focus();
  }

  resetTabOrder() {
    const order = normalizeViewOrder(TUI_VIEWS.map((view) => view.id));
    this.views = order.map((id) => TUI_VIEWS.find((view) => view.id === id)).filter(Boolean);
    this.renderNavTabs();
    this.persistUiState();
    this.setStatus("Tab order reset");
  }

  renderNavTabs() {
    this.nav.setItems(this.views.map((view) => `${view.icon}  ${view.label}  {gray-fg}${view.key}{/gray-fg}`));
    this.bindNavTabHandlers();
    const selected = Math.max(0, this.views.findIndex((view) => view.id === this.activeView));
    this.suppressNextNavSelect = true;
    this.nav.select(selected);
    this.screen.render();
    setImmediate(() => { this.suppressNextNavSelect = false; });
  }

  persistUiState() {
    try {
      saveTuiState(this.statePath, {
        active_view: this.activeView,
        view_order: this.views.map((view) => view.id),
        recent_directories: this.recentDirectories,
        last_directory: this.currentPath || this.primaryRoot
      });
    } catch {
      // UI preferences are best-effort and must never make the TUI unusable.
    }
  }

  rememberDirectory(directory) {
    const resolved = path.resolve(directory);
    this.recentDirectories = [resolved, ...this.recentDirectories.filter((item) => item !== resolved)].slice(0, 12);
    this.persistUiState();
  }

  async handleRow(index) {
    const row = selectedRow(this.rows, index);
    if (row && this.rowHandler) await this.runBusy("Opening item", () => this.rowHandler(row, index));
  }

  updateSelectedRow(index) {
    const row = selectedRow(this.rows, index);
    if (!row) return;
    if (row.preview) this.setDetail(row.title || "Detail", row.preview, { raw: true });
  }

  setDetail(title, content, options = {}) {
    this.detail.setLabel(` ${title} `);
    const text = String(content ?? "");
    this.detail.setContent(options.allowTags ? text : escapeTags(text));
    this.detail.setScroll(0);
    this.screen.render();
  }

  async refreshDashboard() {
    this.showDetailOnly();
    this.setActions([
      { label: "Refresh", key: "R", handler: () => this.refreshDashboard() },
      { label: "Doctor", handler: () => this.showDoctor() },
      { label: "Start", handler: () => this.startRuntime() },
      { label: "Stop", handler: () => this.stopRuntime() }
    ]);
    const settled = await Promise.allSettled([
      this.client.health(),
      this.client.info(),
      this.launcher.doctor(),
      this.client.integration("figma", "status"),
      this.client.integration("dbeaver", "status"),
      this.client.integration("bruno", "status"),
      this.client.memoryHealth(),
      this.launcher.status()
    ]);
    const value = (index, fallback = null) => settled[index].status === "fulfilled" ? settled[index].value : fallback;
    const health = value(0, { status: "offline" });
    const info = value(1, {});
    const doctor = value(2, {});
    const integrations = [
      integrationSummary("Figma", settled[3]),
      integrationSummary("DBeaver", settled[4]),
      integrationSummary("Bruno", settled[5])
    ];
    const memory = value(6, { status: "offline" });
    const launcher = value(7, {});
    this.primaryRoot = path.resolve(info.primary_root || info.workspace || health.workspace || this.primaryRoot);
    this.currentPath ||= this.primaryRoot;
    this.gitRoot ||= this.primaryRoot;
    this.setDetail("Runtime overview", dashboardText({ health, info, doctor, integrations, memory, launcher }), { allowTags: true });
    this.updateHeader(health);
  }

  async showDoctor() {
    const doctor = await this.launcher.doctor();
    this.setDetail("Managed runtime doctor", JSON.stringify(doctor, null, 2), { raw: true });
  }

  async startRuntime() {
    const result = await this.launcher.start();
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Unable to start LCA");
    await this.client.close();
    this.setDetail("Start", result.stdout || "LCA started.", { raw: true });
    await this.refreshDashboard();
  }

  async stopRuntime() {
    if (!await this.confirm("Stop LCA", "Stop the managed server and tunnel?")) return;
    const result = await this.launcher.stop();
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Unable to stop LCA");
    await this.client.close();
    this.setDetail("Stop", result.stdout || "LCA stopped.", { raw: true });
    this.updateHeader({ status: "offline" });
  }

  async refreshProjects() {
    this.setActions([
      { label: "Add Folder", key: "A", handler: () => this.addProject() },
      { label: "Set Primary", handler: () => this.setPrimaryProject() },
      { label: "Remove", handler: () => this.removeProject() },
      { label: "Open Files", handler: () => this.openSelectedProject() },
      { label: "Refresh", handler: () => this.refreshProjects() }
    ]);
    const status = await this.launcher.status();
    const projects = status.projects || [];
    this.primaryRoot = path.resolve(projects[0] || this.primaryRoot);
    const rows = projects.map((project, index) => ({
      path: project,
      primary: index === 0,
      label: `${index === 0 ? "◆" : "◇"} ${project}${index === 0 ? "  [primary]" : ""}`,
      title: index === 0 ? "Primary project" : "Project",
      preview: `${project}\n\n${index === 0 ? "Relative paths, CodeGraph default indexing, and AgentMemory project scope begin here." : "Search and context can include this registered project."}`
    }));
    this.setRows(rows, async (row) => this.setDetail(row.title, row.preview, { raw: true }), "Configured projects");
    this.setDetail("Projects", projects.length ? "Select a project, then use the action buttons.\n\nChanging projects uses the launcher and safely restarts the managed server when necessary." : "No project configured. Click Add.", { raw: true });
  }

  async addProject() {
    const project = await this.pickDirectory("Add project", this.primaryRoot || process.cwd());
    if (!project) return;
    this.rememberDirectory(project);
    const result = await this.launcher.addProject(project);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    await this.client.close();
    await this.refreshProjects();
  }

  async setPrimaryProject() {
    const row = this.selected();
    if (!row?.path) return;
    const result = await this.launcher.setPrimaryProject(row.path);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    await this.client.close();
    this.primaryRoot = path.resolve(row.path);
    await this.refreshProjects();
  }

  async removeProject() {
    const row = this.selected();
    if (!row?.path) return;
    if (!await this.confirm("Remove project", `Remove ${row.path} from discovery roots?\n\nFilesystem access by absolute path is unaffected.`)) return;
    const result = await this.launcher.removeProject(row.path);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    await this.client.close();
    await this.refreshProjects();
  }

  async openSelectedProject() {
    const row = this.selected();
    if (!row?.path) return;
    this.currentPath = path.resolve(row.path);
    this.rememberDirectory(this.currentPath);
    await this.switchView("files");
  }

  async refreshFiles() {
    this.currentPath = path.resolve(this.currentPath || this.primaryRoot);
    this.setActions([
      { label: "Up", handler: () => this.goUpDirectory() },
      { label: "Primary", handler: () => { this.currentPath = this.primaryRoot; return this.refreshFiles(); } },
      { label: "Browse Folder", key: "B", handler: () => this.browseFolder() },
      { label: "Open Path", handler: () => this.openPathPrompt() },
      { label: "Search Here", handler: () => { this.searchRoot = this.currentPath; return this.switchView("search").then(() => this.askSearch()); } },
      { label: "Refresh", handler: () => this.refreshFiles() }
    ]);
    const value = await this.client.listFiles(this.currentPath, { limit: 500 });
    const rows = normalizeFileEntries(value).map((entry) => ({ ...entry, title: entry.path, preview: JSON.stringify(entry, null, 2) }));
    this.setRows(rows, (row) => this.openFileRow(row), compactPath(this.currentPath, 40));
    this.setDetail("File browser", `${this.currentPath}\n\nClick a directory to enter it or a file to read it. Mouse wheel scrolls both panes.`, { raw: true });
  }

  async openFileRow(row) {
    const target = resolveBackendPath(this.primaryRoot, row.path);
    if (row.type === "directory") {
      this.currentPath = target;
      this.rememberDirectory(this.currentPath);
      await this.refreshFiles();
      return;
    }
    const value = await this.client.readFile(target);
    this.setDetail(compactPath(target, 70), fileContent(value), { raw: true });
  }

  async openPathPrompt() {
    const value = await this.prompt("Open path", "File or directory", this.currentPath);
    if (!value) return;
    const target = resolveAgainst(this.currentPath, value);
    const stat = await this.client.data("workspace_read", "stat", { path: target });
    if (stat.type === "directory") {
      this.currentPath = target;
      this.rememberDirectory(this.currentPath);
      await this.refreshFiles();
    } else {
      const file = await this.client.readFile(target);
      this.setDetail(compactPath(target, 70), fileContent(file), { raw: true });
    }
  }

  async goUpDirectory() {
    this.currentPath = path.dirname(this.currentPath);
    this.rememberDirectory(this.currentPath);
    await this.refreshFiles();
  }

  async browseFolder(initial = this.currentPath || this.primaryRoot) {
    const directory = await this.pickDirectory("Browse folders", initial);
    if (!directory) return;
    this.currentPath = path.resolve(directory);
    this.rememberDirectory(this.currentPath);
    if (this.activeView === "files") await this.refreshFiles();
    else await this.switchView("files");
  }

  async refreshSearch() {
    this.setActions([
      { label: "Search", handler: () => this.askSearch() },
      { label: "Use Files Path", handler: () => { this.searchRoot = this.currentPath; return this.askSearch(); } },
      { label: this.searchRegex ? "Regex: ON" : "Regex: OFF", handler: () => { this.searchRegex = !this.searchRegex; return this.refreshSearch(); } },
      { label: "Primary", handler: () => { this.searchRoot = this.primaryRoot; return this.askSearch(); } },
      { label: "Clear", handler: () => { this.lastSearch = ""; return this.refreshSearch(); } }
    ]);
    if (!this.lastSearch) {
      this.setRows([], null, "Matches");
      this.setDetail("Search", `Root: ${this.searchRoot}\n\nClick Search or press / and enter a literal or regular expression. Results open directly at the matching line.`, { raw: true });
      return;
    }
    const value = await this.client.search(this.lastSearch, this.searchRoot, { regex: this.searchRegex, context: 2, limit: 300 });
    const rows = normalizeSearchMatches(value);
    this.setRows(rows, (row) => this.openSearchMatch(row), `${rows.length} matches`);
    this.setDetail("Search", `Query: ${this.lastSearch}\nMode: ${this.searchRegex ? "regular expression" : "literal"}\nRoot: ${this.searchRoot}\nEngine: ${value.engine || "auto"}`, { raw: true });
  }

  async askSearch() {
    const query = await this.prompt("Search workspace", this.searchRegex ? "Regular expression" : "Literal text", this.lastSearch);
    if (!query) return;
    this.lastSearch = query;
    await this.refreshSearch();
  }

  async openSearchMatch(row) {
    const target = resolveBackendPath(this.primaryRoot, row.path);
    const startLine = Math.max(1, Number(row.line || 1) - 20);
    const value = await this.client.readFile(target, { startLine, lineCount: 80 });
    this.setDetail(`${compactPath(target, 60)}:${row.line}`, fileContent(value), { raw: true });
  }

  async refreshContext() {
    this.setActions([
      { label: "Build Context", handler: () => this.buildContext() },
      { label: "Use Files Path", handler: () => { this.searchRoot = this.currentPath; return this.buildContext(); } },
      { label: "Refresh Last", handler: () => this.rebuildContext() }
    ]);
    if (!this.lastContext) {
      this.setRows([], null, "Evidence");
      this.setDetail("Mandatory task context", "Every build queries filesystem search, CodeGraph, and AgentMemory in parallel.\n\nClick Build Context and describe the task. Coverage and provider evidence appear here.", { raw: true });
      return;
    }
    this.renderContext(this.lastContext);
  }

  async buildContext() {
    const task = await this.prompt("Build task context", "Concrete coding task", this.lastContextTask || "Understand the current project architecture");
    if (!task) return;
    this.lastContextTask = task;
    await this.rebuildContext();
  }

  async rebuildContext() {
    if (!this.lastContextTask) return this.buildContext();
    this.lastContext = await this.client.context(this.lastContextTask, this.searchRoot || this.primaryRoot, { intent: "understand" });
    this.renderContext(this.lastContext);
  }

  renderContext(context) {
    const evidence = Array.isArray(context?.evidence) ? context.evidence : [];
    const rows = evidence.map((item) => ({
      ...item,
      label: `${providerIcon(item.provider)} ${item.provider}  ${item.title}`,
      title: item.title,
      preview: item.content
    }));
    this.setRows(rows, async (row) => this.setDetail(row.title, row.content || JSON.stringify(row, null, 2), { raw: true }), "Evidence");
    const coverage = Object.entries(context?.coverage || {})
      .map(([name, receipt]) => `${name.padEnd(13)} ${receipt.status}  hits=${receipt.hits}  ${formatDuration(receipt.latencyMs)}`)
      .join("\n");
    this.setDetail("Coverage receipt", `Task: ${context.task || this.lastContextTask}\nRoot: ${context.root || this.searchRoot}\n\n${coverage}\n\nEvidence: ${evidence.length}`, { raw: true });
  }

  async refreshGit() {
    this.gitRoot = path.resolve(this.gitRoot || this.primaryRoot);
    this.setActions([
      { label: "Refresh", handler: () => this.refreshGit() },
      { label: "Diff", handler: () => this.showGitDiff(false) },
      { label: "Staged", handler: () => this.showGitDiff(true) },
      { label: "Log", handler: () => this.showGitLog() },
      { label: "Branches", handler: () => this.showGitBranches() },
      { label: "Change Repo", handler: () => this.changeGitRoot() }
    ]);
    const value = await this.client.gitStatus(this.gitRoot);
    const rows = normalizeGitRows(value);
    this.setRows(rows, (row) => this.showFileGitDiff(row), `${rows.length} changed`);
    this.setDetail("Git status", JSON.stringify(value, null, 2), { raw: true });
  }

  async showGitDiff(staged) {
    const value = await this.client.gitDiff(this.gitRoot, staged);
    this.setDetail(staged ? "Staged diff" : "Working diff", renderData(value), { raw: true });
  }

  async showFileGitDiff(row) {
    const value = await this.client.git(["diff", "--", row.path], this.gitRoot);
    this.setDetail(row.path, renderData(value), { raw: true });
  }

  async showGitLog() {
    const value = await this.client.git(["log", "--oneline", "--decorate", "-n", "40"], this.gitRoot);
    this.setDetail("Recent commits", renderData(value), { raw: true });
  }

  async showGitBranches() {
    const value = await this.client.git(["branch", "--all", "--verbose", "--no-abbrev"], this.gitRoot);
    this.setDetail("Branches", renderData(value), { raw: true });
  }

  async changeGitRoot() {
    const value = await this.pickDirectory("Git repository", this.gitRoot);
    if (!value) return;
    this.gitRoot = path.resolve(value);
    this.rememberDirectory(this.gitRoot);
    await this.refreshGit();
  }

  async refreshCommands() {
    this.setActions([
      { label: "Run", handler: () => this.runCommandPrompt() },
      { label: "Re-run", handler: () => this.rerunCommand() },
      { label: "Change CWD", handler: () => this.changeCommandCwd() },
      { label: "Clear", handler: () => { this.commandHistory = []; this.lastCommandResult = ""; return this.refreshCommands(); } }
    ]);
    const rows = this.commandHistory.map((item, index) => ({
      ...item,
      label: `${item.ok ? "✓" : "✗"} ${item.command}`,
      title: `Command ${index + 1}`,
      preview: item.output
    }));
    this.setRows(rows, async (row) => this.setDetail(row.command, row.output, { raw: true }), "History");
    this.setDetail("Command runner", this.lastCommandResult || `CWD: ${this.currentPath || this.primaryRoot}\n\nCommands run through workspace_exec with bounded output and timeout.`, { raw: true });
  }

  async runCommandPrompt() {
    const command = await this.prompt("Run command", "Shell command", this.commandHistory.at(-1)?.command || "git status --short");
    if (!command) return;
    await this.executeCommand(command);
  }

  async executeCommand(command) {
    const value = await this.client.command(command, this.currentPath || this.primaryRoot);
    const output = renderData(value);
    const ok = value?.exit_code === 0 && !value?.timed_out;
    this.commandHistory.push({ command, output, ok, value });
    this.lastCommandResult = output;
    await this.refreshCommands();
  }

  async rerunCommand() {
    const row = this.selected() || this.commandHistory.at(-1);
    if (row?.command) await this.executeCommand(row.command);
  }

  async changeCommandCwd() {
    const value = await this.pickDirectory("Command working directory", this.currentPath || this.primaryRoot);
    if (value) {
      this.currentPath = path.resolve(value);
      this.rememberDirectory(this.currentPath);
    }
    await this.refreshCommands();
  }

  async refreshProcesses() {
    this.setActions([
      { label: "Start", handler: () => this.startProcess() },
      { label: "Output", handler: () => this.showProcessOutput() },
      { label: "Stop", handler: () => this.stopProcess() },
      { label: "Refresh", handler: () => this.refreshProcesses() }
    ]);
    const value = await this.client.processes();
    const rows = normalizeProcesses(value);
    this.setRows(rows, (row) => this.openProcess(row), "Managed processes");
    this.setDetail("Processes", rows.length ? "Select a process to view its captured output." : "No managed background processes.", { raw: true });
  }

  async startProcess() {
    const command = await this.prompt("Start process", "Long-running command", "npm run dev");
    if (!command) return;
    const name = await this.prompt("Process name", "Friendly name", command.split(/\s+/)[0]);
    const value = await this.client.processStart(command, this.currentPath || this.primaryRoot, name || undefined);
    this.setDetail("Process started", JSON.stringify(value, null, 2), { raw: true });
    await this.refreshProcesses();
  }

  async openProcess(row) {
    const value = await this.client.processOutput(row.id);
    this.setDetail(row.name || row.id, renderData(value), { raw: true });
  }

  async showProcessOutput() {
    const row = this.selected();
    if (row?.id) await this.openProcess(row);
  }

  async stopProcess() {
    const row = this.selected();
    if (!row?.id) return;
    if (!await this.confirm("Stop process", `Stop ${row.name || row.id}?`)) return;
    await this.client.processStop(row.id);
    await this.refreshProcesses();
  }

  async refreshVerify() {
    const actions = [
      ["detect", "Detect commands"],
      ["changed", "Changed tests"],
      ["tests", "Tests"],
      ["build", "Build"],
      ["lint", "Lint"],
      ["review", "Review diff"],
      ["security", "Security scan"],
      ["gate", "Quality gate"]
    ];
    this.setActions(actions.slice(0, 6).map(([action, label]) => ({ label, handler: () => this.runVerify(action) })));
    const rows = actions.map(([action, label]) => ({ action, label: `✓ ${label}`, preview: `Run workspace_verify action=${action} in ${this.gitRoot}` }));
    this.setRows(rows, (row) => this.runVerify(row.action), "Verification gates");
    this.setDetail("Verification", `Repository: ${this.gitRoot}\n\nClick a gate. No gate runs automatically merely by opening this screen.`, { raw: true });
  }

  async runVerify(action) {
    const value = await this.client.verify(action, this.gitRoot);
    this.setDetail(`Verify: ${action}`, renderData(value), { raw: true });
  }

  async refreshTasks() {
    this.setActions([
      { label: "New Plan", handler: () => this.createPlan() },
      { label: "Mark Done", handler: () => this.markTaskDone() },
      { label: "Save Note", handler: () => this.saveNote() },
      { label: "Checkpoint", handler: () => this.saveCheckpoint() },
      { label: "Undo Patch", handler: () => this.undoPatch() }
    ]);
    const [task, notes] = await Promise.all([
      this.client.taskState().catch(() => null),
      this.client.notes().catch(() => ({ notes: [] }))
    ]);
    const rows = [];
    for (const [index, step] of (task?.steps || []).entries()) {
      const done = Boolean(step.done || step.status === "done");
      rows.push({ kind: "step", index, step, label: `${done ? "✓" : "○"} ${step.title || step.text || step}`, preview: JSON.stringify(step, null, 2) });
    }
    for (const note of notes?.notes || []) rows.push({ kind: "note", ...note, label: `✎ ${note.title}`, preview: note.body || JSON.stringify(note, null, 2) });
    this.setRows(rows, async (row) => this.setDetail(row.kind === "step" ? "Task step" : row.title, row.preview, { raw: true }), "Plan and notes");
    this.setDetail("Current task", task ? JSON.stringify(task, null, 2) : "No active task plan.", { raw: true });
  }

  async createPlan() {
    const goal = await this.prompt("Task plan", "Goal", "Ship the next LCA improvement");
    if (!goal) return;
    const rawSteps = await this.prompt("Task plan", "Steps separated by semicolons", "Understand; Implement; Verify; Document");
    const steps = String(rawSteps || "").split(/[;\n]+/).map((item) => item.trim()).filter(Boolean);
    await this.client.taskPlan(goal, steps);
    await this.refreshTasks();
  }

  async markTaskDone() {
    const row = this.selected();
    if (row?.kind !== "step") return;
    await this.client.taskState({ set_step_done: row.index });
    await this.refreshTasks();
  }

  async saveNote() {
    const title = await this.prompt("Save note", "Title", "LCA note");
    if (!title) return;
    const body = await this.prompt("Save note", "Body", "");
    await this.client.note(title, body || "");
    await this.refreshTasks();
  }

  async saveCheckpoint() {
    const summary = await this.prompt("Checkpoint", "Compact summary", "TUI checkpoint");
    if (!summary) return;
    const next = await this.prompt("Checkpoint", "Next steps separated by semicolons", "Continue implementation; Run verification");
    await this.client.checkpoint(summary, String(next || "").split(/[;\n]+/).map((item) => item.trim()).filter(Boolean));
    await this.refreshTasks();
  }

  async undoPatch() {
    if (!await this.confirm("Undo patch", "Restore the most recent patch backup batch?")) return;
    const value = await this.client.undo();
    this.setDetail("Undo", JSON.stringify(value, null, 2), { raw: true });
  }

  async refreshSkills() {
    this.setActions([
      { label: "Refresh", handler: () => this.refreshSkills() },
      { label: "Read", handler: () => this.readSelectedSkill() },
      { label: "Create", handler: () => this.createSkill() },
      { label: "Delete", handler: () => this.deleteSkill() }
    ]);
    const value = await this.client.skills();
    const rows = normalizeSkills(value);
    this.setRows(rows, (row) => this.readSkill(row), "Skills");
    this.setDetail("Reusable skills", rows.length ? "Select a skill to load its full instructions." : "No skills found.", { raw: true });
  }

  async readSkill(row) {
    const value = await this.client.readSkill(row.name);
    this.setDetail(row.name, renderData(value), { raw: true });
  }

  async readSelectedSkill() {
    const row = this.selected();
    if (row?.name) await this.readSkill(row);
  }

  async createSkill() {
    const name = await this.prompt("Create skill", "Kebab-case name", "my-skill");
    if (!name) return;
    const description = await this.prompt("Create skill", "Description", "Reusable workflow created from the LCA TUI.");
    const body = await this.prompt("Create skill", "Instructions", "# Steps\n\n1. Inspect context.\n2. Perform the task.\n3. Verify the result.");
    await this.client.createSkill(name, description || "", body || "");
    await this.refreshSkills();
  }

  async deleteSkill() {
    const row = this.selected();
    if (!row?.name) return;
    if (!await this.confirm("Delete skill", `Delete ${row.name}?`)) return;
    await this.client.deleteSkill(row.name);
    await this.refreshSkills();
  }

  async refreshIntegrations() {
    this.setActions([
      { label: "Refresh", handler: () => this.refreshIntegrations() },
      { label: "Discover", handler: () => this.discoverIntegration() }
    ]);
    const names = ["figma", "dbeaver", "bruno", "coolify"];
    const settled = await Promise.allSettled(names.map((name) => this.client.integration(name, "status")));
    const rows = names.map((name, index) => {
      const result = settled[index];
      const ok = result.status === "fulfilled" && !isOfflineResult(result.value);
      return {
        name,
        value: result.status === "fulfilled" ? result.value : { error: result.reason?.message || String(result.reason) },
        label: `${ok ? "●" : "○"} ${name}  ${ok ? "connected" : "offline"}`,
        preview: result.status === "fulfilled" ? JSON.stringify(result.value, null, 2) : String(result.reason)
      };
    });
    this.setRows(rows, async (row) => this.setDetail(row.name, row.preview, { raw: true }), "MCP integrations");
    this.setDetail("Integrations", "Figma, DBeaver, Bruno, and Coolify use persistent Streamable HTTP clients. Coolify reads COOLIFY_MCP_AUTH_TOKEN from .env.local. Select one and click Discover to inspect its live upstream actions.", { raw: true });
  }

  async discoverIntegration() {
    const row = this.selected();
    if (!row?.name) return;
    const value = await this.client.integration(row.name, "discover");
    this.setDetail(`${row.name} actions`, JSON.stringify(value, null, 2), { raw: true });
  }

  async refreshMemory() {
    this.setActions([
      { label: "Refresh", handler: () => this.refreshMemory() },
      { label: "Export", handler: () => this.exportMemory() },
      { label: "Import Dry", handler: () => this.importMemory(true) },
      { label: "Import", handler: () => this.importMemory(false) }
    ]);
    const [status, health] = await Promise.all([
      this.launcher.memoryStatus(),
      this.client.memoryHealth()
    ]);
    this.memoryBackupDir = status.backup_directory || this.memoryBackupDir;
    const backups = status.backups || [];
    const rows = backups.map((backup) => ({
      ...backup,
      label: `▣ ${compactPath(backup.path, 52)}  ${formatBytes(backup.bytes)}`,
      preview: JSON.stringify(backup, null, 2)
    }));
    this.setRows(rows, async (row) => this.setDetail("Backup", row.preview, { raw: true }), "Backups");
    this.setDetail("AgentMemory", `${JSON.stringify(health, null, 2)}\n\n${JSON.stringify(status, null, 2)}`, { raw: true });
  }

  async exportMemory() {
    const defaultPath = path.join(this.memoryBackupDir, `lca-memory-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    const file = await this.prompt("Export AgentMemory", "Output file", defaultPath);
    if (!file) return;
    const value = await this.launcher.memoryExport(file);
    this.setDetail("Memory export", JSON.stringify(value, null, 2), { raw: true });
    await this.refreshMemory();
  }

  async importMemory(dryRun) {
    const row = this.selected();
    const file = await this.prompt(dryRun ? "Validate AgentMemory backup" : "Import AgentMemory", "Backup file", row?.path || "");
    if (!file) return;
    if (!dryRun && !await this.confirm("Import memory", `Import ${file} using skip strategy?\n\nA pre-import backup is created automatically.`)) return;
    const value = await this.launcher.memoryImport(file, { dryRun, strategy: "skip" });
    this.setDetail(dryRun ? "Memory validation" : "Memory import", JSON.stringify(value, null, 2), { raw: true });
    await this.refreshMemory();
  }

  async refreshTools(force = false) {
    this.setActions([
      { label: "Refresh", handler: () => this.refreshTools(true) },
      { label: "Discover", handler: () => this.discoverTool() },
      { label: "Call", handler: () => this.callSelectedTool() }
    ]);
    const listed = await this.client.listTools({ refresh: force });
    const rows = (listed.tools || []).map((tool) => ({
      ...tool,
      label: `⌘ ${tool.name}  ${tool.description || ""}`,
      preview: JSON.stringify(tool, null, 2)
    }));
    this.setRows(rows, async (row) => this.setDetail(row.name, row.preview, { raw: true }), `${rows.length} compact tools`);
    this.setDetail("Tool console", "This is the escape hatch to every compact façade and all 136 hidden backend actions.\n\nSelect a façade, click Discover, then Call with a JSON input object.", { raw: true });
  }

  async discoverTool() {
    const row = this.selected();
    if (!row?.name) return;
    if (["workspace_context", "lca_input"].includes(row.name)) {
      this.setDetail(row.name, row.preview, { raw: true });
      return;
    }
    const value = await this.client.discover(row.name);
    this.setDetail(`${row.name} actions`, JSON.stringify(value, null, 2), { raw: true });
  }

  async callSelectedTool() {
    const row = this.selected();
    if (!row?.name) return;
    const raw = await this.prompt(`Call ${row.name}`, "JSON arguments", row.name === "workspace_context" ? JSON.stringify({ task: "Inspect the current project", path: this.primaryRoot, intent: "understand" }) : "{}");
    if (raw === null) return;
    const args = safeJsonParse(raw, {});
    const result = await this.client.callTool(row.name, args);
    this.setDetail(`${row.name} result`, formatToolResult(result), { raw: true });
  }

  async refreshLogs() {
    this.setActions([
      { label: "Launcher", handler: () => this.openLog(this.logPaths.launcher) },
      { label: "Lifecycle", handler: () => this.openLog(this.logPaths.lifecycle) },
      { label: "Audit", handler: () => this.openLog(this.logPaths.audit) },
      { label: "Refresh", handler: () => this.openLog(this.lastLogPath) }
    ]);
    const rows = [
      ["launcher", this.logPaths.launcher],
      ["lifecycle", this.logPaths.lifecycle],
      ["audit", this.logPaths.audit]
    ].filter(([, value]) => value).map(([name, file]) => ({ name, path: file, label: `≋ ${name}  ${file}`, preview: file }));
    this.setRows(rows, (row) => this.openLog(row.path), "Log files");
    if (this.lastLogPath) await this.openLog(this.lastLogPath);
    else this.setDetail("Logs", "No log path configured.", { raw: true });
  }

  async openLog(file) {
    if (!file) return;
    this.lastLogPath = file;
    try {
      const value = await this.client.readFile(file, { maxChars: 200_000 });
      const content = fileContent(value);
      const lines = content.split(/\r?\n/);
      this.setDetail(compactPath(file, 70), lines.slice(-2000).join("\n"), { raw: true });
    } catch (error) {
      this.setDetail(compactPath(file, 70), `Unable to read log: ${error.message}`, { raw: true });
    }
  }

  async refreshHelp() {
    this.showDetailOnly();
    this.setActions([
      { label: "Dashboard", handler: () => this.switchView("dashboard") },
      { label: "Browse Folder", handler: () => this.browseFolder() },
      { label: "Reset Tabs", handler: () => this.resetTabOrder() }
    ]);
    const featureLines = this.views.filter((view) => view.id !== "help").map((view) => `${view.icon} ${view.label.padEnd(16)} shortcut ${view.key}`);
    const shortcutLines = TUI_SHORTCUTS.map(([key, description]) => `${key.padEnd(24)} ${description}`);
    this.setDetail("LCA TUI help", [
      "{bold}Feature screens{/bold}",
      ...featureLines,
      "",
      "{bold}Keyboard and mouse{/bold}",
      ...shortcutLines,
      "",
      "{bold}Behavior{/bold}",
      "The TUI is a real compact MCP client. It auto-reconnects after project changes or server restarts.",
      "Closing the TUI does not stop the managed LCA server or tunnel.",
      "Project roots guide discovery and relative paths; absolute paths remain available.",
      "Folder pickers browse the local machine directly, keep recent folders, and avoid typing long paths.",
      "Sidebar tabs can be dragged or moved with Alt+Up/Down; their order persists in tui-state.json.",
      "The Tool Console exposes action discovery and raw JSON calls for the complete compact surface."
    ].join("\n"), { allowTags: true });
  }

  async showPalette() {
    this.modalOpen = true;
    const items = [
      ...this.views.map((view) => ({ label: `${view.icon} ${view.label}`, run: () => this.switchView(view.id) })),
      { label: "▣ Browse local folder", run: () => this.browseFolder() },
      { label: "↕ Reset tab order", run: () => this.resetTabOrder() },
      { label: "↻ Refresh active screen", run: () => this.refreshActiveView() },
      { label: "▶ Start managed runtime", run: () => this.startRuntime() },
      { label: "■ Stop managed runtime", run: () => this.stopRuntime() },
      { label: "⌘ Run command", run: () => this.switchView("commands").then(() => this.runCommandPrompt()) },
      { label: "◈ Build mandatory context", run: () => this.switchView("context").then(() => this.buildContext()) }
    ];
    const overlay = blessed.list({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "60%",
      height: "70%",
      label: " Command palette ",
      border: { type: "line" },
      keys: true,
      vi: true,
      mouse: true,
      tags: true,
      items: items.map((item) => item.label),
      scrollbar: { ch: "▐", style: { bg: THEME.accent } },
      style: {
        bg: THEME.panel,
        fg: THEME.text,
        border: { fg: THEME.accent },
        selected: { bg: THEME.accent, fg: "black", bold: true },
        label: { fg: THEME.accent2 }
      }
    });
    const finish = async (operation = null) => {
      overlay.destroy();
      this.modalOpen = false;
      this.screen.render();
      if (operation) await this.runBusy("Palette action", operation);
    };
    overlay.on("select", (_item, index) => void finish(items[index]?.run));
    overlay.key(["escape", "q"], () => void finish());
    overlay.focus();
    this.screen.render();
  }

  pickDirectory(title, initial = this.primaryRoot) {
    return new Promise((resolve) => {
      this.modalOpen = true;
      let current = path.resolve(initial || this.primaryRoot || process.cwd());
      let rows = [];
      let done = false;
      let loading = false;
      let ignoreNextSelect = false;
      const box = blessed.box({
        parent: this.screen,
        top: "center",
        left: "center",
        width: "82%",
        height: "82%",
        label: ` ${title} `,
        border: { type: "line" },
        keys: true,
        mouse: true,
        style: { bg: THEME.panel, fg: THEME.text, border: { fg: THEME.accent }, label: { fg: THEME.accent2 } }
      });
      blessed.text({
        parent: box,
        top: 0,
        left: 2,
        right: 2,
        height: 1,
        content: "Navigate with mouse/Enter · Backspace goes up · Space selects current folder",
        style: { fg: THEME.muted }
      });
      const pathInput = blessed.textbox({
        parent: box,
        top: 2,
        left: 2,
        right: 2,
        height: 3,
        border: { type: "line" },
        value: current,
        keys: true,
        mouse: true,
        inputOnFocus: true,
        style: { bg: THEME.bg, fg: THEME.text, border: { fg: THEME.border }, focus: { border: { fg: THEME.accent } } }
      });
      const list = blessed.list({
        parent: box,
        top: 5,
        left: 2,
        right: 2,
        bottom: 3,
        label: " Folders ",
        border: { type: "line" },
        keys: true,
        vi: true,
        mouse: true,
        scrollable: true,
        alwaysScroll: true,
        scrollbar: { ch: "▐", style: { bg: THEME.accent } },
        style: {
          bg: THEME.bg,
          fg: THEME.text,
          border: { fg: THEME.border },
          selected: { bg: THEME.accent, fg: "black", bold: true },
          item: { hover: { bg: THEME.panelAlt, fg: THEME.accent } },
          label: { fg: THEME.accent2 }
        }
      });
      const status = blessed.text({
        parent: box,
        bottom: 2,
        left: 2,
        right: 36,
        height: 1,
        content: "",
        style: { fg: THEME.muted }
      });
      const select = modalButton(box, "Select", "center", -20, THEME.accent);
      const home = modalButton(box, "Home", "center", -4, THEME.border);
      const cancel = modalButton(box, "Cancel", "center", 10, THEME.border);

      const finish = (value) => {
        if (done) return;
        done = true;
        pathInput.cancel?.();
        box.destroy();
        this.modalOpen = false;
        this.screen.render();
        resolve(value);
      };
      const openRow = async (row) => {
        if (!row || loading) return;
        if (row.kind === "select") return finish(current);
        await refresh(nextPickerDirectory(row, current));
      };
      const bindRows = () => {
        for (const [index, item] of (list.items || []).entries()) {
          item.on("mousedown", () => {
            ignoreNextSelect = true;
            list.select(index);
            list.focus();
            this.screen.render();
            void Promise.resolve(openRow(rows[index])).finally(() => {
              setImmediate(() => { ignoreNextSelect = false; });
            });
          });
        }
      };
      const refresh = async (directory) => {
        if (loading || done) return;
        loading = true;
        status.setContent("Loading folders…");
        this.screen.render();
        try {
          const next = path.resolve(directory);
          const nextRows = await directoryPickerRows(next, { recentDirectories: this.recentDirectories });
          current = next;
          rows = nextRows;
          pathInput.setValue(current);
          list.setItems(rows.map((row) => escapeTags(row.label)));
          bindRows();
          if (rows.length) list.select(0);
          status.setContent(`${rows.filter((row) => row.kind === "directory").length} subfolders`);
          list.focus();
        } catch (error) {
          status.setContent(`Unable to open: ${escapeTags(error.message)}`);
        } finally {
          loading = false;
          this.screen.render();
        }
      };

      list.on("select", (_item, index) => {
        if (ignoreNextSelect) return;
        void openRow(rows[index]);
      });
      list.key(["backspace", "left"], () => void refresh(path.dirname(current)));
      list.key(["space", "s"], () => finish(current));
      list.key(["escape", "q"], () => finish(null));
      pathInput.on("submit", (value) => void refresh(value || current));
      pathInput.key(["escape"], () => { pathInput.cancel?.(); list.focus(); this.screen.render(); });
      select.on("press", () => finish(current));
      home.on("press", () => void refresh(os.homedir()));
      cancel.on("press", () => finish(null));
      box.key(["escape"], () => finish(null));
      box.key(["C-l"], () => pathInput.focus());
      void refresh(current);
    });
  }

  prompt(title, label, initial = "") {
    return new Promise((resolve) => {
      this.modalOpen = true;
      const form = blessed.form({
        parent: this.screen,
        top: "center",
        left: "center",
        width: "72%",
        height: 10,
        label: ` ${title} `,
        border: { type: "line" },
        keys: true,
        mouse: true,
        style: { bg: THEME.panel, fg: THEME.text, border: { fg: THEME.accent }, label: { fg: THEME.accent2 } }
      });
      blessed.text({ parent: form, top: 1, left: 2, right: 2, height: 1, content: label, style: { fg: THEME.muted } });
      const input = blessed.textbox({
        parent: form,
        top: 3,
        left: 2,
        right: 2,
        height: 3,
        border: { type: "line" },
        value: String(initial ?? ""),
        keys: true,
        mouse: true,
        inputOnFocus: true,
        style: { bg: THEME.bg, fg: THEME.text, border: { fg: THEME.border }, focus: { border: { fg: THEME.accent } } }
      });
      const ok = modalButton(form, "OK", "center", -7, THEME.accent);
      const cancel = modalButton(form, "Cancel", "center", 5, THEME.border);
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        input.cancel?.();
        form.destroy();
        this.modalOpen = false;
        this.screen.render();
        resolve(value);
      };
      input.on("submit", (value) => finish(value));
      input.key(["escape"], () => finish(null));
      ok.on("press", () => finish(input.getValue()));
      cancel.on("press", () => finish(null));
      form.key(["escape"], () => finish(null));
      input.focus();
      this.screen.render();
    });
  }

  confirm(title, message) {
    return new Promise((resolve) => {
      this.modalOpen = true;
      const box = blessed.box({
        parent: this.screen,
        top: "center",
        left: "center",
        width: "62%",
        height: 10,
        label: ` ${title} `,
        border: { type: "line" },
        tags: true,
        padding: { left: 2, right: 2 },
        content: escapeTags(message),
        style: { bg: THEME.panel, fg: THEME.text, border: { fg: THEME.warning }, label: { fg: THEME.warning } }
      });
      const yes = modalButton(box, "Yes", "center", -7, THEME.warning);
      const no = modalButton(box, "No", "center", 5, THEME.border);
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        box.destroy();
        this.modalOpen = false;
        this.screen.render();
        resolve(value);
      };
      yes.on("press", () => finish(true));
      no.on("press", () => finish(false));
      box.key(["y", "enter"], () => finish(true));
      box.key(["n", "escape", "q"], () => finish(false));
      no.focus();
      this.screen.render();
    });
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

export async function runLcaTui(options) {
  const app = new LcaTuiApp(options);
  await app.run();
}

function modalButton(parent, label, left, offset, bg) {
  const centeredLeft = typeof left === "string" && left === "center" ? `50%${offset >= 0 ? "+" : ""}${offset}` : left;
  return blessed.button({
    parent,
    bottom: 1,
    left: centeredLeft,
    width: label.length + 4,
    height: 1,
    mouse: true,
    keys: true,
    content: ` ${label} `,
    style: { bg, fg: "black", focus: { bg: THEME.accent2, fg: "black", bold: true }, hover: { bg: THEME.accent2, fg: "black" } }
  });
}

function escapeTags(value) {
  return String(value ?? "").replaceAll("{", "\\{").replaceAll("}", "\\}");
}

function renderData(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function fileContent(value) {
  if (typeof value === "string") return value;
  return value?.content ?? JSON.stringify(value, null, 2);
}

function resolveAgainst(base, value) {
  const text = String(value || "");
  return path.isAbsolute(text) ? path.resolve(text) : path.resolve(base, text);
}

function providerIcon(provider) {
  if (provider === "filesystem") return "▤";
  if (provider === "codegraph") return "⌘";
  if (provider === "agentmemory") return "∞";
  return "·";
}

function integrationSummary(name, settled) {
  if (settled.status === "rejected") return { name, ok: false, detail: settled.reason?.message || "offline" };
  const value = settled.value;
  return { name, ok: !isOfflineResult(value), detail: isOfflineResult(value) ? value?.error || "offline" : "connected" };
}

function isOfflineResult(value) {
  if (!value || typeof value !== "object") return false;
  return value.connected === false || value.status === "offline" || Boolean(value.error);
}
