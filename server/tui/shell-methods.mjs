import path from "node:path";
import blessed from "neo-blessed";
import { TUI_VIEWS, compactPath } from "./model.mjs";
import { normalizePaneSplitPercent } from "./state.mjs";
import { THEME } from "./theme.mjs";
import { escapeTags } from "./view-helpers.mjs";

export class TuiShellMethods {
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

    this.resourceTabBar = blessed.box({
      parent: this.main,
      top: 3,
      left: 0,
      right: 0,
      height: 3,
      hidden: true,
      border: { type: "line" },
      label: " Workspaces / Files ",
      style: { bg: THEME.panelAlt, border: { fg: THEME.border }, label: { fg: THEME.accent2 } }
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

    this.paneDivider = blessed.box({
      parent: this.main,
      top: 3,
      left: "40%",
      width: 1,
      bottom: 0,
      hidden: true,
      mouse: true,
      content: "│",
      style: { bg: THEME.panelAlt, fg: THEME.accent }
    });
    this.paneDivider.on("mousedown", () => {
      this.paneDragging = true;
      this.paneDivider.setContent("┃");
      this.screen.render();
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
      if (this.paneDragging) this.updatePaneSplitFromMouse(data);
      const index = this.navIndexFromMouse(data);
      if (index >= 0) this.updateNavDrag(index);
    });
    this.screen.on("mouseup", (data) => {
      if (this.paneDragging) this.finishPaneDrag();
      if (!this.navDrag) return;
      const index = this.navIndexFromMouse(data);
      this.finishNavDrag(index >= 0 ? index : this.navDrag.target);
    });
    this.screen.program.on("mouse", (data) => {
      if (this.paneDragging && data.action === "mousemove") this.updatePaneSplitFromMouse(data);
      if (this.paneDragging && data.action === "mouseup") this.finishPaneDrag();
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
    this.screen.key(["M-left"], () => {
      if (!this.modalOpen) this.adjustPaneSplit(-4);
    });
    this.screen.key(["M-right"], () => {
      if (!this.modalOpen) this.adjustPaneSplit(4);
    });
    this.screen.key(["C-pageup"], () => {
      if (!this.modalOpen) void this.cycleResourceTab(-1);
    });
    this.screen.key(["C-pagedown"], () => {
      if (!this.modalOpen) void this.cycleResourceTab(1);
    });
    this.screen.key(["C-w"], () => {
      if (!this.modalOpen && this.activeView === "files") void this.closeActiveResourceTab();
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
    if (this.activeView === "files") this.showResourceTabStrip();
    else this.hideResourceTabStrip();
    this.paneDivider.show();
    this.applyPaneSplit(this.paneSplitPercent);
  }

  showDetailOnly() {
    this.list.hide();
    this.hideResourceTabStrip();
    this.paneDivider.hide();
    this.detail.top = 3;
    this.detail.left = 0;
    this.detail.right = 0;
    this.detail.width = undefined;
  }

  showResourceTabStrip() {
    this.resourceTabBar.show();
    this.resourceTabBar.setFront();
    this.list.top = 6;
    this.detail.top = 6;
    this.paneDivider.top = 6;
    this.renderResourceTabs();
  }

  hideResourceTabStrip() {
    this.resourceTabBar.hide();
    this.list.top = 3;
    this.detail.top = 3;
    this.paneDivider.top = 3;
  }

  applyPaneSplit(value) {
    this.paneSplitPercent = normalizePaneSplitPercent(value, this.paneSplitPercent);
    const position = `${this.paneSplitPercent}%`;
    this.list.width = position;
    this.paneDivider.left = position;
    this.detail.left = position;
    this.detail.width = undefined;
    this.detail.right = 0;
    this.screen.render();
  }

  adjustPaneSplit(delta) {
    if (this.list.hidden) return;
    this.applyPaneSplit(this.paneSplitPercent + Number(delta || 0));
    this.persistUiState();
    this.setStatus(`Pane split ${this.paneSplitPercent}% / ${100 - this.paneSplitPercent}%`);
  }

  updatePaneSplitFromMouse(data) {
    const position = this.main.lpos;
    if (!position || !Number.isFinite(data?.x)) return;
    const width = Math.max(1, position.xl - position.xi);
    const percent = ((data.x - position.xi) / width) * 100;
    this.applyPaneSplit(percent);
  }

  finishPaneDrag() {
    if (!this.paneDragging) return;
    this.paneDragging = false;
    this.paneDivider.setContent("│");
    this.persistUiState();
    this.setStatus(`Pane split ${this.paneSplitPercent}% / ${100 - this.paneSplitPercent}%`);
  }

}
