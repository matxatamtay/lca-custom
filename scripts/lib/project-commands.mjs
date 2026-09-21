import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { emitKeypressEvents } from "node:readline";

export function createProjectCommands(options) {
  const {
    effectiveOptions, normalize, normalizeProjectRoots, promoteProjectRoot, saveConfig,
    stripRuntimeFields, start, stop, restartIfRunning, runningStatusForConfig, capture, REPO_ROOT
  } = options;

  async function detectWorkspaceRoot(cwd = process.cwd()) {
    const git = process.platform === "win32" ? "git.exe" : "git";
    const result = await capture(git, ["-C", cwd, "rev-parse", "--show-toplevel"]);
    const root = result.code === 0 ? result.stdout.trim() : "";
    return root && existsSync(root) ? resolve(root) : resolve(cwd);
  }

  async function runCurrentWorkspace(flags) {
    const workspace = resolve(flags.workspace || await detectWorkspaceRoot());
    const opts = normalize({ ...effectiveOptions(flags), workspace });
    await saveConfig(stripRuntimeFields(opts));
    return start({ ...flags, workspace });
  }

  async function resolveProjectArgument(rest, flags = {}) {
    if (rest.length > 1) throw new Error("Expected at most one project path.");
    return resolve(rest[0] || flags.workspace || await detectWorkspaceRoot());
  }

  function effectiveProjectCommandOptions(flags = {}) {
    const configFlags = { ...flags };
    delete configFlags.workspace;
    delete configFlags.extraRoots;
    return effectiveOptions(configFlags);
  }

  function projectConfig(opts, projects) {
    const roots = normalizeProjectRoots({ projects });
    return normalize({
      ...opts,
      projects: roots,
      workspace: roots[0] || "",
      extraRoots: roots.slice(1).join(";")
    });
  }

  function printProjectList(projects) {
    console.log(`Projects: ${projects.length}`);
    for (const project of projects) console.log(`  - ${project}`);
  }

  async function addProjectCommand(rest, flags) {
    const before = effectiveProjectCommandOptions(flags);
    const project = await resolveProjectArgument(rest, flags);
    if (!isDirectory(project)) throw new Error(`Project directory does not exist: ${project}`);
    if (before.projects.includes(project)) {
      console.log(`Already added: ${project}`);
      printProjectList(before.projects);
      return;
    }
    const next = projectConfig(before, [...before.projects, project]);
    await saveConfig(stripRuntimeFields(next));
    console.log(`Added: ${project}`);
    printProjectList(next.projects);
    const restarted = await restartIfRunning(before, next);
    if (!restarted) console.log("Agent is offline. Start it with: lca-custom start --background");
  }

  async function removeProjectCommand(rest, flags) {
    const before = effectiveProjectCommandOptions(flags);
    const project = await resolveProjectArgument(rest, flags);
    if (!before.projects.includes(project)) {
      console.log(`Not registered: ${project}`);
      printProjectList(before.projects);
      return;
    }
    const next = projectConfig(before, before.projects.filter((item) => item !== project));
    await saveConfig(stripRuntimeFields(next));
    console.log(`Removed: ${project}`);
    printProjectList(next.projects);
    const running = await runningStatusForConfig(before);
    if (!running.running) return;
    if (!next.projects.length) {
      console.log("No projects remain; stopping the running agent.");
      await stop(before);
      return;
    }
    await restartIfRunning(before, next);
  }

  async function primaryProjectCommand(rest, flags) {
    const before = effectiveProjectCommandOptions(flags);
    const project = await resolveProjectArgument(rest, flags);
    if (!isDirectory(project)) throw new Error(`Project directory does not exist: ${project}`);
    if (before.projects[0] === project) {
      output.write(`Already primary: ${project}\n`);
      printProjectList(before.projects);
      return;
    }
    const nextProjects = promoteProjectRoot(before.projects, project);
    const next = projectConfig(before, nextProjects);
    await saveConfig(stripRuntimeFields(next));
    output.write(`Primary project: ${project}\n`);
    printProjectList(next.projects);
    const restarted = await restartIfRunning(before, next);
    if (!restarted) output.write("Agent is offline. Start it with: lca-custom start --background\n");
  }

  async function resetProjectsCommand(rest, flags) {
    const before = effectiveProjectCommandOptions(flags);
    const project = await resolveProjectArgument(rest, flags);
    if (!isDirectory(project)) throw new Error(`Project directory does not exist: ${project}`);
    const next = projectConfig(before, [project]);
    await saveConfig(stripRuntimeFields(next));
    console.log(`Reset projects to: ${project}`);
    const restarted = await restartIfRunning(before, next);
    if (!restarted) console.log("Agent is offline. Start it with: lca-custom start --background");
  }

  function isDirectory(path) {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  function workspaceItems(current) {
    const items = [
      { label: "Select this folder", type: "select", path: current },
      { label: "Back ..", type: "open", path: dirname(current) }
    ];
    const children = readdirSync(current, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== ".git" && !entry.name.startsWith("."))
      .map((entry) => join(current, entry.name))
      .sort((a, b) => basename(a).localeCompare(basename(b)));
    for (const child of children) {
      const repo = existsSync(join(child, ".git"));
      items.push({ label: `${basename(child)}/${repo ? "  [repo]" : ""}`, type: repo ? "select" : "open", path: child });
    }
    return items;
  }

  function renderWorkspacePicker(current, items, selected) {
    output.write("\x1b[H\x1b[2J\x1b[?25l");
    output.write("Choose workspace\n");
    output.write(`Path: ${current}\n\n`);
    output.write("Up/Down: move  Enter: select/open  q: quit\n\n");
    items.forEach((item, index) => {
      if (index === selected) output.write(`\x1b[7m> ${item.label}\x1b[0m\n`);
      else output.write(`  ${item.label}\n`);
    });
  }

  function readKeypress() {
    return new Promise((resolveKey) => {
      const onKey = (str, key = {}) => {
        input.off("keypress", onKey);
        resolveKey({ str, key });
      };
      input.on("keypress", onKey);
    });
  }

  async function pickWorkspace(startDir) {
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
      throw new Error("Interactive terminal required for workspace picker.");
    }
    let current = resolve(startDir);
    if (!isDirectory(current)) current = REPO_ROOT;
    let selected = 0;
    const wasRaw = input.isRaw;
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    try {
      while (true) {
        const items = workspaceItems(current);
        if (selected >= items.length) selected = 0;
        renderWorkspacePicker(current, items, selected);
        const { str, key } = await readKeypress();
        if (key.name === "up") selected = selected <= 0 ? items.length - 1 : selected - 1;
        else if (key.name === "down") selected = selected >= items.length - 1 ? 0 : selected + 1;
        else if (key.name === "return" || key.name === "enter") {
          const item = items[selected];
          if (item.type === "select") return resolve(item.path);
          current = resolve(item.path);
          selected = 0;
        } else if (str === "q" || str === "Q" || (key.ctrl && key.name === "c")) {
          return "";
        }
      }
    } finally {
      input.setRawMode(Boolean(wasRaw));
      output.write("\x1b[?25h\x1b[0m\n");
    }
  }

  async function workspaceCommand(flags) {
    const opts = effectiveOptions(flags);
    const startDir = flags.workspace || opts.workspace || process.cwd();
    const choice = await pickWorkspace(startDir);
    if (!choice) {
      console.log("Canceled.");
      return;
    }
    const next = normalize({ ...opts, workspace: choice });
    await saveConfig(stripRuntimeFields(next));
    console.log(`Workspace: ${choice}`);
    console.log("Run: lca-custom");
  }


  return {
    detectWorkspaceRoot, runCurrentWorkspace, addProjectCommand, removeProjectCommand,
    primaryProjectCommand, resetProjectsCommand, workspaceCommand
  };
}
