import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface as createPromptInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import {
  ManagedAgentMemoryService, agentMemoryPortabilityStatus, exportAgentMemoryBackup, importAgentMemoryBackup
} from "../agentmemory-portability.mjs";
import { openUrl } from "./open-url.mjs";

export function createIntegrationCommands(options) {
  const {
    AGENTMEMORY_PORTABILITY_PATHS, DEFAULT_FIGMA_DESKTOP_MCP_URL, LCA_VERSION,
    SERVER_DIR, effectiveOptions, ensureManagedRuntime, restartIfRunning
  } = options;

  function figmaDesktopEndpoint() {
    return String(process.env.FIGMA_DESKTOP_MCP_URL || DEFAULT_FIGMA_DESKTOP_MCP_URL).trim();
  }

  async function loadFigmaDesktopBridge() {
    if (!existsSync(join(SERVER_DIR, "node_modules"))) {
      throw new Error("Figma bridge dependencies are missing. Run `lca-custom setup` or `lca-custom install` first.");
    }
    return import(pathToFileURL(join(SERVER_DIR, "figma-desktop.mjs")).href);
  }

  async function figmaDesktopStatusCli() {
    const bridge = await loadFigmaDesktopBridge();
    return bridge.figmaDesktopStatus({ endpoint: figmaDesktopEndpoint() });
  }

  async function listFigmaDesktopToolsCli() {
    const bridge = await loadFigmaDesktopBridge();
    return bridge.listFigmaDesktopTools({ endpoint: figmaDesktopEndpoint() });
  }

  function printFigmaDesktopEnableSteps(statusValue = {}) {
    console.log(`Figma Desktop MCP: ${statusValue.endpoint || DEFAULT_FIGMA_DESKTOP_MCP_URL}`);
    console.log("  1. Open the Figma desktop app and sign in.");
    console.log("  2. Open a Figma Design file.");
    console.log("  3. Switch to Dev Mode (Shift+D).");
    console.log('  4. In the MCP server section, click "Enable desktop MCP server".');
  }

  function openFigmaDesktop() {
    try {
      if (process.platform === "darwin") {
        const child = spawn("open", ["-a", "Figma"], { stdio: "ignore", detached: true, windowsHide: true });
        child.unref();
        return true;
      }
      return openUrl("figma://");
    } catch {
      return false;
    }
  }

  async function ensureFigmaDesktopConnected(rl, { interactive = false, failOnMissing = false } = {}) {
    let statusValue = await figmaDesktopStatusCli();
    if (statusValue.connected) {
      console.log(`Figma Desktop MCP connected: ${statusValue.endpoint}`);
      console.log(`Tools: ${statusValue.tools.join(", ") || "none"}`);
      return statusValue;
    }

    console.log(statusValue.error || "Figma Desktop MCP is not available.");
    printFigmaDesktopEnableSteps(statusValue);
    if (interactive) {
      if (openFigmaDesktop()) console.log("Opened Figma Desktop.");
      await rl.question("Enable the MCP server in Figma, then press Enter to retry: ");
      statusValue = await figmaDesktopStatusCli();
      if (statusValue.connected) {
        console.log(`Figma Desktop MCP connected: ${statusValue.endpoint}`);
        console.log(`Tools: ${statusValue.tools.join(", ") || "none"}`);
        return statusValue;
      }
      console.log(statusValue.error || "Figma Desktop MCP is still unavailable.");
    }

    if (failOnMissing) throw new Error(statusValue.error || "Figma Desktop MCP is not available.");
    console.log("You can finish later with: lca-custom figma");
    return statusValue;
  }

  function agentMemoryPortabilityOptions() {
    const baseUrl = process.env.AGENTMEMORY_URL || "http://127.0.0.1:3111";
    const service = new ManagedAgentMemoryService({
      paths: AGENTMEMORY_PORTABILITY_PATHS,
      baseUrl
    });
    return {
      paths: AGENTMEMORY_PORTABILITY_PATHS,
      baseUrl,
      secret: process.env.AGENTMEMORY_SECRET || "",
      service,
      lcaVersion: LCA_VERSION
    };
  }

  function printMemoryReceipt(receipt) {
    if (receipt.kind === "agentmemory_export") {
      console.log(`AgentMemory backup: ${receipt.path}`);
      console.log(`Checksum: ${receipt.checksum}`);
      console.log(`Sessions: ${receipt.counts.sessions}, observations: ${receipt.counts.observations}, memories: ${receipt.counts.memories}`);
      return;
    }
    if (receipt.kind === "agentmemory_import") {
      console.log(`${receipt.dry_run ? "Validated" : "Imported"}: ${receipt.input}`);
      console.log(`Strategy: ${receipt.strategy}; checksum: ${receipt.checksum}`);
      if (receipt.pre_import_backup?.path) console.log(`Pre-import backup: ${receipt.pre_import_backup.path}`);
      if (receipt.result) console.log(`Result: ${JSON.stringify(receipt.result)}`);
      return;
    }
    if (receipt.kind === "agentmemory_portability_status") {
      console.log(`AgentMemory service: ${receipt.service.ready ? "healthy" : "offline"}`);
      console.log(`Backup directory: ${receipt.backup_directory}`);
      console.log(`Backups: ${receipt.backups.length}`);
      for (const backup of receipt.backups.slice(0, 10)) console.log(`  - ${backup.path} (${backup.bytes} bytes)`);
    }
  }

  async function memoryCommand(rest, flags = {}) {
    const [sub = "status", file, ...extra] = rest;
    if (extra.length > 0) throw new Error("Too many memory command arguments.");
    const common = agentMemoryPortabilityOptions();

    if (sub === "status") {
      if (file) throw new Error("Usage: lca-custom memory status [--json]");
      const receipt = await agentMemoryPortabilityStatus(common);
      if (flags.json) console.log(JSON.stringify(receipt, null, 2));
      else printMemoryReceipt(receipt);
      return receipt;
    }

    if (sub === "export") {
      await ensureManagedRuntime(effectiveOptions(flags));
      const receipt = await exportAgentMemoryBackup({
        ...common,
        ...(file ? { outputPath: resolve(file) } : {})
      });
      if (flags.json) console.log(JSON.stringify(receipt, null, 2));
      else printMemoryReceipt(receipt);
      return receipt;
    }

    if (sub === "import") {
      if (!file) throw new Error("Usage: lca-custom memory import <file> [--dry-run] [--strategy skip|merge|replace] [--force] [--json]");
      const strategy = String(flags.strategy || "skip").toLowerCase();
      if (strategy === "replace" && flags.force !== true) {
        throw new Error("AgentMemory replace import requires --force because it clears existing memory state.");
      }
      if (!flags.dryRun) await ensureManagedRuntime(effectiveOptions(flags));
      const receipt = await importAgentMemoryBackup({
        ...common,
        inputPath: resolve(file),
        strategy,
        dryRun: flags.dryRun === true
      });
      if (flags.json) console.log(JSON.stringify(receipt, null, 2));
      else printMemoryReceipt(receipt);
      return receipt;
    }

    throw new Error("Usage: lca-custom memory status|export [file]|import <file>");
  }

  async function figmaCommand(rest, flags = {}) {
    const [sub = "connect"] = rest;
    if (sub === "status") {
      console.log(JSON.stringify(await figmaDesktopStatusCli(), null, 2));
      return;
    }
    if (sub === "tools") {
      const listed = await listFigmaDesktopToolsCli();
      console.log(JSON.stringify({ endpoint: figmaDesktopEndpoint(), count: listed.tools.length, tools: listed.tools }, null, 2));
      return;
    }
    if (sub === "open") {
      if (!openFigmaDesktop()) console.log("Could not open Figma automatically.");
      printFigmaDesktopEnableSteps({ endpoint: figmaDesktopEndpoint() });
      return;
    }
    if (sub !== "connect" && sub !== "check") {
      throw new Error("Usage: lca-custom figma [connect|status|tools|open]");
    }

    if (!input.isTTY || !output.isTTY) {
      const statusValue = await figmaDesktopStatusCli();
      console.log(JSON.stringify(statusValue, null, 2));
      if (!statusValue.connected) process.exitCode = 1;
      return;
    }

    const rl = createPromptInterface({ input, output });
    let statusValue;
    try {
      statusValue = await ensureFigmaDesktopConnected(rl, { interactive: true, failOnMissing: false });
    } finally {
      rl.close();
    }
    if (!statusValue.connected) {
      process.exitCode = 1;
      return;
    }

    const opts = effectiveOptions(flags);
    await restartIfRunning(opts, opts);
  }


  return { ensureFigmaDesktopConnected, figmaCommand, memoryCommand };
}
