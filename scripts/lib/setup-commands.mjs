import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface as createPromptInterface } from "node:readline/promises";
import {
  detectSetupPlatform, isPlaceholder, platformMatchesHost, setupPlatformChoices
} from "./setup-platform.mjs";
import { createSetupRuntime } from "./setup-runtime.mjs";
import { createCliInstaller } from "./cli-install.mjs";
import { promptChoice, promptLine, promptSecretRequired, promptYesNo } from "./prompt-ui.mjs";

export function createSetupCommands(options) {
  const {
    CLI_NAME, CONFIG_PATH, DEFAULT_PORT, ENV_EXAMPLE_PATH, ENV_LOCAL_PATH, KEY_URLS,
    MIN_NODE_MAJOR, REPO_ROOT, SCRIPT_DIR, capture, defaultTunnelBinForPlatform,
    effectiveOptions, ensureFigmaDesktopConnected, installManagedRuntimeCommand, isDirectory,
    readRepoEnvFile, runChecked, saveConfig, sha256, setupUsage, stripRuntimeFields,
    validate, writeRepoEnv
  } = options;

  const { checkPrerequisites, downloadTunnelClient, openKeyPages, printInstructionMode, printStep } = createSetupRuntime({
    capture, defaultTunnelBinForPlatform, KEY_URLS, MIN_NODE_MAJOR, promptYesNo, sha256
  });
  const { cliWrapperContents, installCliCommand } = createCliInstaller({
    CLI_NAME, CONFIG_PATH, REPO_ROOT, SCRIPT_DIR, capture
  });

  async function setup(flags) {
    if (flags.help) return setupUsage();
    if (!input.isTTY || !output.isTTY) {
      throw new Error("Interactive terminal required. Run `lca-custom setup` from a terminal.");
    }
    const cfg = effectiveOptions(flags);
    const rl = createPromptInterface({ input, output });
    try {
      const host = detectSetupPlatform();
      const selected = flags.chooseOs
        ? await promptChoice(rl, "Choose target operating system", setupPlatformChoices(), host.id)
        : host;
      if (!platformMatchesHost(selected, host)) {
        printInstructionMode(selected, host);
        return;
      }

      console.log(`Detected OS: ${selected.label}`);
      console.log(`Config file: ${CONFIG_PATH}`);
      console.log(`Environment file: ${ENV_LOCAL_PATH}`);

      printStep(1, 9, "Check prerequisites");
      await checkPrerequisites(selected);

      printStep(2, 9, "Choose tunnel mode");
      const useTunnel = await promptYesNo(rl, "Use ChatGPT Web tunnel", !cfg.noTunnel);
      cfg.noTunnel = !useTunnel;
      if (useTunnel) await openKeyPages(rl);

      printStep(3, 9, "Configure local environment");
      const envValues = readRepoEnvFile();
      if (useTunnel) {
        cfg.tunnelId = await promptLine(rl, "Tunnel ID", flags.tunnelId || (!isPlaceholder(envValues.CONTROL_PLANE_TUNNEL_ID) ? envValues.CONTROL_PLANE_TUNNEL_ID : cfg.tunnelId));
        const currentKey = !isPlaceholder(envValues.CONTROL_PLANE_API_KEY) ? envValues.CONTROL_PLANE_API_KEY : "";
        const runtimeKey = await promptSecretRequired(rl, "Runtime API key", flags.runtimeKey || currentKey);
        if (!cfg.tunnelId) throw new Error("Tunnel ID is required when tunnel mode is enabled.");
        if (!runtimeKey) throw new Error("Runtime API key is required when tunnel mode is enabled.");
        await writeRepoEnv({
          CONTROL_PLANE_TUNNEL_ID: cfg.tunnelId,
          CONTROL_PLANE_API_KEY: runtimeKey
        });
        cfg.runtimeKeyEnv = "CONTROL_PLANE_API_KEY";
        cfg.runtimeKey = "";
        console.log("Saved .env.local");
      } else if (!existsSync(ENV_LOCAL_PATH) && existsSync(ENV_EXAMPLE_PATH)) {
        await writeFile(ENV_LOCAL_PATH, readFileSync(ENV_EXAMPLE_PATH, "utf8"), "utf8");
        console.log("Created .env.local from .env.example");
      } else {
        console.log("Tunnel disabled; .env.local can be filled later.");
      }

      printStep(4, 9, "Configure trusted local runtime");
      cfg.node = cfg.node || "node";
      cfg.workspace = await promptLine(rl, "First project root", cfg.workspace || process.cwd());
      cfg.port = await promptLine(rl, "MCP port", cfg.port || DEFAULT_PORT);
      console.log("Runtime: trusted-local, compact 15-tool facade, direct execution without policy or approval round-trips.");
      cfg.extraRoots = flags.extraRoots ?? cfg.extraRoots ?? "";
      cfg.authToken = flags.authToken ?? cfg.authToken ?? "";

      printStep(5, 9, "Install managed runtime");
      await installManagedRuntimeCommand({ ...flags, json: false });

      printStep(6, 9, "Connect Figma Desktop MCP");
      const useFigmaDesktop = await promptYesNo(rl, "Enable Figma Desktop integration", true);
      if (useFigmaDesktop) {
        await ensureFigmaDesktopConnected(rl, { interactive: true, failOnMissing: false });
      } else {
        console.log("Skipped. Run `lca-custom figma` later.");
      }

      printStep(7, 9, "Install tunnel-client");
      if (useTunnel) {
        cfg.tunnelBin = cfg.tunnelBin || defaultTunnelBinForPlatform(selected);
        if (!existsSync(cfg.tunnelBin)) {
          try {
            cfg.tunnelBin = await downloadTunnelClient(selected, cfg.tunnelBin);
          } catch (error) {
            console.log(`Download failed: ${error.message}`);
            cfg.tunnelBin = await promptLine(rl, "Manual tunnel-client path", cfg.tunnelBin);
            if (!existsSync(cfg.tunnelBin)) throw new Error(`Tunnel client not found: ${cfg.tunnelBin}`);
          }
        } else {
          console.log(`Using existing tunnel-client: ${cfg.tunnelBin}`);
        }
        cfg.profileDir = cfg.profileDir || join(REPO_ROOT, "tools", "profiles");
        cfg.profile = cfg.profile || "local-coding-agent-custom";
        cfg.organizationId = flags.organizationId || cfg.organizationId || "";
      } else {
        console.log("Tunnel disabled.");
      }

      printStep(8, 9, "Save config and install lca-custom command");
      cfg.runtimeKey = "";
      const normalizedCfg = normalize(cfg);
      validate(normalizedCfg);
      await saveConfig(stripRuntimeFields(normalizedCfg));
      const cliPath = await installCliCommand();

      printStep(9, 9, "Verify");
      await verifyCliShim(cliPath);
      await status({ json: false });
      console.log("\nSetup complete.");
      console.log("Daily use:");
      console.log("  lca-custom add /path/to/another-project");
      console.log("  lca-custom start --background");
      console.log(`Health: http://127.0.0.1:${cfg.port}/healthz`);
    } finally {
      rl.close();
    }
  }


  return { setup, installCliCommand, cliWrapperContents };
}
