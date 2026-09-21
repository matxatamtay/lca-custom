import path from "node:path";
import { appendCommandHistory, commandHistoryScope } from "./state.mjs";
import {
  TUI_SHORTCUTS, compactPath, formatBytes, formatToolResult, normalizeProcesses,
  normalizeSkills, safeJsonParse
} from "./model.mjs";
import { fileContent, isOfflineResult, renderData } from "./view-helpers.mjs";

export class TuiOperationViewMethods {
  currentCommandScope() {
    const target = path.resolve(this.currentPath || this.primaryRoot);
    const containing = this.resourceTabs
      .filter((tab) => tab.kind === "workspace" && (target === tab.path || target.startsWith(`${tab.path}${path.sep}`)))
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (containing) return commandHistoryScope(containing.path, this.primaryRoot);
    const active = this.activeResourceTab();
    if (active?.kind === "workspace") return commandHistoryScope(active.path, this.primaryRoot);
    if (active?.kind === "file") {
      const workspace = this.resourceTabs.find((tab) => tab.kind === "workspace" && active.path.startsWith(`${tab.path}${path.sep}`));
      if (workspace) return commandHistoryScope(workspace.path, this.primaryRoot);
    }
    return commandHistoryScope(this.primaryRoot);
  }

  commandHistory() {
    return this.commandHistories[this.currentCommandScope()] || [];
  }

  async refreshCommands() {
    const scope = this.currentCommandScope();
    const history = this.commandHistory();
    this.setActions([
      { label: "Run", handler: () => this.runCommandPrompt() },
      { label: "Re-run", handler: () => this.rerunCommand() },
      { label: "Change CWD", handler: () => this.changeCommandCwd() },
      { label: "Clear Project", handler: () => { delete this.commandHistories[scope]; this.lastCommandResult = ""; this.persistUiState(); return this.refreshCommands(); } }
    ]);
    const rows = history.map((item, index) => ({
      ...item,
      label: `${item.ok ? "✓" : "✗"} ${item.command}`,
      title: `Command ${index + 1}`,
      preview: item.output
    }));
    this.setRows(rows, async (row) => this.setDetail(row.command, row.output, { raw: true }), `History · ${path.basename(scope) || scope}`);
    this.setDetail("Command runner", this.lastCommandResult || history.at(-1)?.output || `Project: ${scope}\nCWD: ${this.currentPath || scope}\n\nHistory is persisted per project with bounded output.`, { raw: true });
  }

  async runCommandPrompt() {
    const history = this.commandHistory();
    const command = await this.prompt("Run command", "Shell command", history.at(-1)?.command || "git status --short");
    if (!command) return;
    await this.executeCommand(command);
  }

  async executeCommand(command) {
    const scope = this.currentCommandScope();
    const cwd = this.currentPath || scope;
    const value = await this.client.command(command, cwd);
    const output = renderData(value);
    const ok = value?.exit_code === 0 && !value?.timed_out;
    this.commandHistories = appendCommandHistory(this.commandHistories, scope, {
      command,
      cwd,
      output,
      ok,
      exit_code: value?.exit_code,
      timed_out: value?.timed_out === true,
      created_at: new Date().toISOString()
    });
    this.lastCommandResult = output;
    this.persistUiState();
    await this.refreshCommands();
  }

  async rerunCommand() {
    const row = this.selected() || this.commandHistory().at(-1);
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
      "Files and workspaces open in a second tab strip. Pin protects a tab from close; Ctrl+W closes the active unpinned tab.",
      "Drag the list/detail divider or use Alt+Left/Right. Ctrl+P supports fuzzy action search.",
      "Command history is bounded and persisted separately for each registered workspace.",
      "The Tool Console exposes action discovery and raw JSON calls for the complete compact surface."
    ].join("\n"), { allowTags: true });
  }

}
