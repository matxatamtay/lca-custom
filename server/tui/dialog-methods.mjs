import path from "node:path";
import blessed from "neo-blessed";
import { directoryPickerRows, nextPickerDirectory } from "./folder-picker.mjs";
import { fuzzyFilter } from "./palette.mjs";
import { THEME } from "./theme.mjs";
import { escapeTags, modalButton } from "./view-helpers.mjs";

export class TuiDialogMethods {
  async showPalette() {
    this.modalOpen = true;
    const activeTab = this.activeResourceTab();
    const items = [
      ...this.views.map((view) => ({ label: `${view.icon} ${view.label}`, searchText: `view screen ${view.label} ${view.id}`, run: () => this.switchView(view.id) })),
      ...this.resourceTabs.map((tab) => ({
        label: `${tab.kind === "workspace" ? "▣" : "·"} Open ${tab.title}${tab.pinned ? " [pinned]" : ""}`,
        searchText: `resource workspace file tab open ${tab.title} ${tab.path}`,
        run: () => this.activateResourceTab(tab.id)
      })),
      { label: "▣ Browse local folder", searchText: "browse open folder directory workspace", run: () => this.browseFolder() },
      { label: "↕ Reset sidebar tab order", searchText: "reset reorder sidebar tabs", run: () => this.resetTabOrder() },
      { label: activeTab?.pinned ? "◇ Unpin active resource tab" : "◆ Pin active resource tab", searchText: "pin unpin active file workspace tab", run: () => this.toggleResourceTabPin() },
      { label: "× Close active resource tab", searchText: "close remove file workspace tab", run: () => this.closeActiveResourceTab() },
      { label: "⇤ Narrow list pane", searchText: "resize split pane list detail left narrower", run: () => this.adjustPaneSplit(-6) },
      { label: "⇥ Widen list pane", searchText: "resize split pane list detail right wider", run: () => this.adjustPaneSplit(6) },
      { label: "↻ Refresh active screen", searchText: "refresh reload current", run: () => this.refreshActiveView() },
      { label: "▶ Start managed runtime", searchText: "start runtime server daemon", run: () => this.startRuntime() },
      { label: "■ Stop managed runtime", searchText: "stop runtime server daemon", run: () => this.stopRuntime() },
      { label: "⌘ Run command", searchText: "execute shell command terminal", run: () => this.switchView("commands").then(() => this.runCommandPrompt()) },
      { label: "◈ Build mandatory context", searchText: "build task context codegraph agentmemory filesystem", run: () => this.switchView("context").then(() => this.buildContext()) }
    ];
    let filtered = items;
    const box = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "64%",
      height: "74%",
      label: " Command palette · fuzzy search ",
      border: { type: "line" },
      keys: true,
      mouse: true,
      style: { bg: THEME.panel, fg: THEME.text, border: { fg: THEME.accent }, label: { fg: THEME.accent2 } }
    });
    const input = blessed.textbox({
      parent: box,
      top: 1,
      left: 2,
      right: 2,
      height: 3,
      border: { type: "line" },
      label: " Search ",
      keys: true,
      mouse: true,
      inputOnFocus: true,
      style: { bg: THEME.bg, fg: THEME.text, border: { fg: THEME.border }, focus: { border: { fg: THEME.accent } }, label: { fg: THEME.muted } }
    });
    const overlay = blessed.list({
      parent: box,
      top: 4,
      left: 2,
      right: 2,
      bottom: 1,
      label: ` Results · ${items.length} `,
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
        border: { fg: THEME.border },
        selected: { bg: THEME.accent, fg: "black", bold: true },
        item: { hover: { bg: THEME.panelAlt, fg: THEME.accent } },
        label: { fg: THEME.accent2 }
      }
    });
    let done = false;
    const update = () => {
      if (done) return;
      const query = input.getValue();
      filtered = fuzzyFilter(items, query, 100);
      overlay.setItems(filtered.map((item) => item.label));
      overlay.setLabel(` Results · ${filtered.length}/${items.length}${query ? ` · ${escapeTags(query)}` : ""} `);
      if (filtered.length) overlay.select(0);
      this.screen.render();
    };
    const finish = async (operation = null) => {
      if (done) return;
      done = true;
      input.cancel?.();
      box.destroy();
      this.modalOpen = false;
      this.screen.render();
      if (operation) await this.runBusy("Palette action", operation);
    };
    input.on("keypress", () => setImmediate(update));
    input.on("submit", () => void finish(filtered[0]?.run));
    input.key(["down"], () => { input.cancel?.(); overlay.focus(); overlay.select(0); this.screen.render(); });
    input.key(["escape"], () => void finish());
    overlay.on("select", (_item, index) => void finish(filtered[index]?.run));
    overlay.key(["escape"], () => void finish());
    overlay.key(["up"], () => {
      if (overlay.selected === 0) {
        input.focus();
        input.readInput();
        this.screen.render();
      }
    });
    input.focus();
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

}
