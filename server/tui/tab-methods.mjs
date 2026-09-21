import path from "node:path";
import blessed from "neo-blessed";
import {
  closeResourceTab, createResourceTab, nextResourceTabId, toggleResourceTabPinned,
  updateWorkspaceTabLocation, upsertResourceTab
} from "./resource-tabs.mjs";
import { normalizeViewOrder, reorderItems, saveTuiState } from "./state.mjs";
import { TUI_VIEWS, compactPath, selectedRow } from "./model.mjs";
import { THEME } from "./theme.mjs";
import { escapeTags } from "./view-helpers.mjs";

export class TuiTabMethods {
  activeResourceTab() {
    return this.resourceTabs.find((tab) => tab.id === this.activeResourceTabId) || this.resourceTabs[0] || null;
  }

  renderResourceTabs() {
    for (const button of this.resourceTabButtons) button.destroy();
    this.resourceTabButtons = [];
    let left = 1;
    const maxWidth = Math.max(30, (this.main.width || this.screen.width || 120) - 8);
    for (const tab of this.resourceTabs) {
      const active = tab.id === this.activeResourceTabId;
      const prefix = tab.kind === "workspace" ? "▣" : "·";
      const title = compactPath(tab.title, 22);
      const mainLabel = ` ${prefix} ${title} `;
      const mainWidth = Math.max(8, mainLabel.length);
      if (left + mainWidth + 6 > maxWidth) break;
      const button = blessed.button({
        parent: this.resourceTabBar,
        top: 0,
        left,
        width: mainWidth,
        height: 1,
        mouse: true,
        keys: true,
        content: mainLabel,
        style: {
          bg: active ? THEME.accent : THEME.border,
          fg: active ? "black" : THEME.text,
          bold: active,
          hover: { bg: THEME.accent2, fg: "black" }
        }
      });
      button.on("press", () => void this.activateResourceTab(tab.id));
      this.resourceTabButtons.push(button);
      left += mainWidth;

      const pin = blessed.button({
        parent: this.resourceTabBar,
        top: 0,
        left,
        width: 3,
        height: 1,
        mouse: true,
        keys: true,
        content: tab.pinned ? " ◆ " : " ◇ ",
        style: { bg: THEME.panelAlt, fg: tab.pinned ? THEME.warning : THEME.muted, hover: { bg: THEME.accent2, fg: "black" } }
      });
      pin.on("press", () => this.toggleResourceTabPin(tab.id));
      this.resourceTabButtons.push(pin);
      left += 3;

      const close = blessed.button({
        parent: this.resourceTabBar,
        top: 0,
        left,
        width: 3,
        height: 1,
        mouse: true,
        keys: true,
        content: tab.pinned ? " ■ " : " × ",
        style: { bg: THEME.panelAlt, fg: tab.pinned ? THEME.muted : THEME.danger, hover: { bg: THEME.danger, fg: "black" } }
      });
      close.on("press", () => void this.closeResourceTabById(tab.id));
      this.resourceTabButtons.push(close);
      left += 4;
    }
    this.resourceTabBar.setLabel(` Workspaces / Files · ${this.resourceTabs.length} `);
    this.screen.render();
  }

  async activateResourceTab(id) {
    const tab = this.resourceTabs.find((item) => item.id === id);
    if (!tab) return;
    this.activeResourceTabId = tab.id;
    this.currentPath = tab.kind === "workspace" ? path.resolve(tab.current_path || tab.path) : path.dirname(tab.path);
    this.rememberDirectory(this.currentPath);
    this.persistUiState();
    if (this.activeView === "files") await this.refreshFiles();
    else await this.switchView("files");
  }

  openWorkspaceTab(directory, options = {}) {
    const root = path.resolve(options.root || directory);
    const currentPath = path.resolve(directory);
    const tab = createResourceTab("workspace", root, { current_path: currentPath, title: options.title });
    this.resourceTabs = upsertResourceTab(this.resourceTabs, tab);
    this.activeResourceTabId = tab.id;
    this.currentPath = currentPath;
    this.rememberDirectory(currentPath);
    this.persistUiState();
    return tab;
  }

  openFileTab(file, options = {}) {
    const tab = createResourceTab("file", file, { title: options.title });
    this.resourceTabs = upsertResourceTab(this.resourceTabs, tab);
    this.activeResourceTabId = tab.id;
    this.currentPath = path.dirname(tab.path);
    this.persistUiState();
    return tab;
  }

  updateActiveWorkspaceLocation(directory) {
    const active = this.activeResourceTab();
    if (active?.kind === "workspace") {
      this.resourceTabs = updateWorkspaceTabLocation(this.resourceTabs, active.id, directory);
      this.currentPath = path.resolve(directory);
      this.rememberDirectory(this.currentPath);
      this.persistUiState();
      return active;
    }
    return this.openWorkspaceTab(directory);
  }

  toggleResourceTabPin(id = this.activeResourceTabId) {
    this.resourceTabs = toggleResourceTabPinned(this.resourceTabs, id);
    this.persistUiState();
    this.renderResourceTabs();
  }

  async closeResourceTabById(id) {
    const currentIndex = Math.max(0, this.resourceTabs.findIndex((tab) => tab.id === id));
    const result = closeResourceTab(this.resourceTabs, id, this.primaryRoot);
    if (!result.closed) {
      this.setStatus(result.reason === "pinned" ? "Pinned tab: unpin it before closing" : "Tab not found", result.reason !== "pinned");
      return;
    }
    this.resourceTabs = result.tabs;
    const fallback = this.resourceTabs[Math.min(currentIndex, this.resourceTabs.length - 1)] || this.resourceTabs[0];
    this.activeResourceTabId = fallback?.id || "";
    this.persistUiState();
    if (fallback) await this.activateResourceTab(fallback.id);
    else await this.refreshFiles();
  }

  async closeActiveResourceTab() {
    await this.closeResourceTabById(this.activeResourceTabId);
  }

  async cycleResourceTab(direction) {
    if (this.activeView !== "files") return;
    const id = nextResourceTabId(this.resourceTabs, this.activeResourceTabId, direction);
    if (id) await this.activateResourceTab(id);
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
        last_directory: this.currentPath || this.primaryRoot,
        pane_split_percent: this.paneSplitPercent,
        resource_tabs: this.resourceTabs,
        active_resource_tab: this.activeResourceTabId,
        command_histories: this.commandHistories
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

}
