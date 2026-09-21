import path from "node:path";
import {
  compactPath, dashboardText, formatDuration, normalizeFileEntries, normalizeGitRows,
  normalizeSearchMatches, resolveBackendPath
} from "./model.mjs";
import {
  fileContent, integrationSummary, providerIcon, renderData, resolveAgainst
} from "./view-helpers.mjs";

export class TuiWorkspaceViewMethods {
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
      preview: `${project}\n\n${index === 0 ? "Default project when no target is supplied. Explicit paths route across all registered projects as peers." : "Read, edit, exec, search, and context can route to this registered peer project."}`
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
    this.openWorkspaceTab(row.path, { root: row.path, title: path.basename(row.path) });
    await this.switchView("files");
  }

  async refreshFiles() {
    let active = this.activeResourceTab();
    if (!active) active = this.openWorkspaceTab(this.primaryRoot, { root: this.primaryRoot });
    this.currentPath = active.kind === "workspace"
      ? path.resolve(active.current_path || active.path)
      : path.dirname(active.path);
    this.setActions([
      { label: "Up", handler: () => this.goUpDirectory() },
      { label: "Primary", handler: () => { this.openWorkspaceTab(this.primaryRoot, { root: this.primaryRoot }); return this.refreshFiles(); } },
      { label: "Browse Folder", key: "B", handler: () => this.browseFolder() },
      { label: active.pinned ? "Unpin Tab" : "Pin Tab", handler: () => this.toggleResourceTabPin(active.id) },
      { label: "Close Tab", handler: () => this.closeResourceTabById(active.id) },
      { label: "Open Path", handler: () => this.openPathPrompt() },
      { label: "Search Here", handler: () => { this.searchRoot = this.currentPath; return this.switchView("search").then(() => this.askSearch()); } },
      { label: "Refresh", handler: () => this.refreshFiles() }
    ]);
    const value = await this.client.listFiles(this.currentPath, { limit: 500 });
    const rows = normalizeFileEntries(value).map((entry) => ({ ...entry, title: entry.path, preview: JSON.stringify(entry, null, 2) }));
    this.setRows(rows, (row) => this.openFileRow(row), compactPath(this.currentPath, 40));
    if (active.kind === "file") {
      const file = await this.client.readFile(active.path);
      this.setDetail(compactPath(active.path, 70), fileContent(file), { raw: true });
    } else {
      this.setDetail("File browser", `${this.currentPath}\n\nClick a directory to enter it or a file to open it in a tab. Drag the divider to resize panes.`, { raw: true });
    }
    this.renderResourceTabs();
  }

  async openFileRow(row) {
    const target = resolveBackendPath(this.primaryRoot, row.path);
    if (row.type === "directory") {
      this.updateActiveWorkspaceLocation(target);
      await this.refreshFiles();
      return;
    }
    this.openFileTab(target);
    await this.refreshFiles();
  }

  async openPathPrompt() {
    const value = await this.prompt("Open path", "File or directory", this.currentPath);
    if (!value) return;
    const target = resolveAgainst(this.currentPath, value);
    const stat = await this.client.data("workspace_read", "stat", { path: target });
    if (stat.type === "directory") {
      this.updateActiveWorkspaceLocation(target);
      await this.refreshFiles();
    } else {
      this.openFileTab(target);
      await this.refreshFiles();
    }
  }

  async goUpDirectory() {
    this.updateActiveWorkspaceLocation(path.dirname(this.currentPath));
    await this.refreshFiles();
  }

  async browseFolder(initial = this.currentPath || this.primaryRoot) {
    const directory = await this.pickDirectory("Browse folders", initial);
    if (!directory) return;
    this.openWorkspaceTab(directory, { root: directory });
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
    this.openFileTab(target);
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
      this.setDetail("Mandatory task context", "Every build queries filesystem search, native semantic analysis, CodeGraph, and AgentMemory in parallel.\n\nClick Build Context and describe the task. Coverage and provider evidence appear here.", { raw: true });
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

}
