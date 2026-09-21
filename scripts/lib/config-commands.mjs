import { stdin as input, stdout as output } from "node:process";
import { createInterface as createPromptInterface } from "node:readline/promises";
import { promptChoice, promptLine, promptSecretUpdate, promptYesNo } from "./prompt-ui.mjs";

export function createConfigCommands(options) {
  const { CONFIG_PATH, DEFAULT_PORT, loadConfig, normalize, restartIfRunning, saveConfig, stripRuntimeFields, validate } = options;

  function redactConfigForDisplay(cfg) {
    const visible = { ...cfg };
    if (visible.runtimeKey) visible.runtimeKey = "<saved>";
    if (visible.authToken) visible.authToken = "<saved>";
    return visible;
  }

  async function promptConfigWizard() {
    if (!input.isTTY || !output.isTTY) {
      throw new Error("Interactive terminal required. Use `lca-custom config show` for non-interactive output.");
    }
    const beforeCfg = normalize(loadConfig());
    const cfg = { ...beforeCfg };
    const rl = createPromptInterface({ input, output });
    let saved = false;
    try {
      while (true) {
        console.log("\nLocal Coding Agent config");
        console.log(`  Workspace: ${cfg.workspace || "(not set)"}`);
        console.log("  Runtime:   trusted-local / compact");
        console.log(`  MCP port:  ${cfg.port}`);
        console.log(`  Tunnel:    ${cfg.noTunnel ? "disabled" : "enabled"}`);
        console.log("");
        const action = await promptChoice(rl, "Choose what to change", [
          { id: "workspace", label: "Workspace path" },
          { id: "port", label: "MCP port" },
          { id: "tunnel", label: "Tunnel on/off" },
          { id: "show", label: "Show full config" },
          { id: "save", label: "Save and apply" },
          { id: "cancel", label: "Cancel" }
        ], "save");
        if (action.id === "workspace") {
          cfg.workspace = await promptLine(rl, "Workspace path", cfg.workspace || process.cwd());
        } else if (action.id === "port") {
          cfg.port = await promptLine(rl, "MCP port", cfg.port || DEFAULT_PORT);
        } else if (action.id === "tunnel") {
          cfg.noTunnel = await promptYesNo(rl, "Server only, no tunnel", cfg.noTunnel);
        } else if (action.id === "show") {
          console.log(JSON.stringify(redactConfigForDisplay(cfg), null, 2));
        } else if (action.id === "save") {
          const normalizedCfg = normalize(cfg);
          validate(normalizedCfg);
          await saveConfig(stripRuntimeFields(normalizedCfg));
          saved = true;
          console.log("Saved config.");
          const restarted = await restartIfRunning(beforeCfg, normalizedCfg);
          if (!restarted) console.log("Agent is not running; next `lca-custom` will use the new config.");
          break;
        } else if (action.id === "cancel") {
          console.log("Canceled.");
          break;
        }
      }
    } finally {
      rl.close();
    }
    return saved;
  }

  async function configCommand(rest) {
    const [sub, key, ...valueParts] = rest;
    const beforeCfg = normalize(loadConfig());
    const cfg = loadConfig();
    if (!sub) {
      return promptConfigWizard();
    }
    if (sub === "show") {
      console.log(JSON.stringify(redactConfigForDisplay(cfg), null, 2));
      return;
    }
    if (sub === "path") {
      console.log(CONFIG_PATH);
      return;
    }
    if (sub === "set") {
      if (!key || valueParts.length === 0) throw new Error("Usage: config set <key> <value>");
      cfg[key] = valueParts.join(" ");
      await saveConfig(cfg);
      console.log(`Set ${key}.`);
      await restartIfRunning(beforeCfg, normalize(cfg));
      return;
    }
    if (sub === "unset") {
      if (!key) throw new Error("Usage: config unset <key>");
      delete cfg[key];
      await saveConfig(cfg);
      console.log(`Unset ${key}.`);
      await restartIfRunning(beforeCfg, normalize(cfg));
      return;
    }
    throw new Error(`Unknown config command: ${sub}`);
  }

  async function keyCommand(rest) {
    const [sub] = rest;
    const cfg = loadConfig();
    if (sub === "clear") {
      cfg.runtimeKey = "";
      await saveConfig(cfg);
      console.log("Cleared saved runtime key.");
      return;
    }
    if (sub === "set") {
      const rl = createPromptInterface({ input, output });
      try {
        console.log("Warning: the universal CLI stores this key in a local config file, not DPAPI.");
        cfg.runtimeKey = await promptSecretUpdate(rl, "Runtime API key", cfg.runtimeKey);
        await saveConfig(cfg);
        console.log("Saved runtime key.");
      } finally {
        rl.close();
      }
      return;
    }
    throw new Error("Usage: key set|clear");
  }




  return { configCommand, keyCommand };
}
