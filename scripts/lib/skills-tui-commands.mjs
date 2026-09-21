import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";

export function createSkillsTuiCommands(options) {
  const {
    CLI_SCRIPT_PATH, CONFIG_PATH, LCA_VERSION, LOG_PATH, REPO_ROOT, SERVER_DIR, SCRIPT_DIR,
    effectiveOptions, ensureManagedRuntime, readJson, runChecked, runningStatusForConfig, start, validate
  } = options;

  function parseSkillMeta(text, fallbackName) {
    const fm = text.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/);
    let name = fallbackName;
    let description = "";
    if (fm) {
      const block = fm[1];
      name = (block.match(/^\s*name\s*:\s*(.+?)\s*$/im)?.[1] || fallbackName).replace(/^["']|["']$/g, "").trim();
      description = (block.match(/^\s*description\s*:\s*(.+?)\s*$/im)?.[1] || "").replace(/^["']|["']$/g, "").trim();
    }
    return { name, description };
  }

  function listRepoSkills() {
    const skillsDir = join(REPO_ROOT, "skills");
    if (!existsSync(skillsDir)) return [];
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const file = join(skillsDir, entry.name, "SKILL.md");
        if (!existsSync(file)) return { folder: entry.name, name: entry.name, description: "(missing SKILL.md)" };
        const meta = parseSkillMeta(readFileSync(file, "utf8"), entry.name);
        return { folder: entry.name, ...meta };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function tuiCommand(flags = {}) {
    if (!input.isTTY || !output.isTTY) {
      throw new Error("Interactive terminal required for lca-custom tui.");
    }
    const opts = effectiveOptions(flags);
    validate(opts, { requireWorkspace: true, requireTunnel: true });
    await ensureManagedRuntime(opts);
    const running = await runningStatusForConfig(opts);
    if (!running.health?.status || running.health.status !== "ok") {
      await start({ ...opts, background: true, skipManagedRuntime: true });
    }
    const health = await readJson(`http://127.0.0.1:${opts.port}/healthz`, 5_000);
    if (!health?.status || health.status !== "ok") {
      throw new Error(`LCA server is unavailable at http://127.0.0.1:${opts.port}/healthz`);
    }
    const tuiPath = join(SERVER_DIR, "tui.mjs");
    if (!existsSync(tuiPath)) throw new Error(`Missing TUI entrypoint: ${tuiPath}`);
    const child = spawn(opts.node, [tuiPath], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        LCA_CUSTOM_CONFIG_PATH: CONFIG_PATH,
        LCA_TUI_CONFIG_PATH: CONFIG_PATH,
        LCA_TUI_CLI_SCRIPT: CLI_SCRIPT_PATH,
        LCA_TUI_ENDPOINT: `http://127.0.0.1:${opts.port}/mcp`,
        LCA_TUI_AUTH_TOKEN: opts.authToken || "",
        LCA_TUI_WORKSPACE: opts.workspace,
        LCA_TUI_REPO_ROOT: REPO_ROOT,
        LCA_TUI_SERVER_DATA: join(SERVER_DIR, "data"),
        LCA_TUI_LAUNCHER_LOG: LOG_PATH,
        LCA_TUI_VERSION: LCA_VERSION
      },
      stdio: "inherit",
      windowsHide: false,
      shell: false
    });
    const code = await new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (value) => resolveExit(value ?? 1));
    });
    if (code !== 0) throw new Error(`LCA TUI exited with code ${code}`);
  }

  async function skillsCommand(rest) {
    const [sub = "list"] = rest;
    if (sub === "list") {
      for (const skill of listRepoSkills()) {
        console.log(`${skill.name} - ${skill.description}`);
      }
      return;
    }
    if (sub === "validate") {
      await runChecked("skills", process.execPath, [join(SCRIPT_DIR, "validate-skills.mjs")], { cwd: REPO_ROOT });
      return;
    }
    throw new Error("Usage: skills list|validate");
  }


  return { skillsCommand, tuiCommand };
}
