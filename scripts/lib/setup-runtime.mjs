import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import os from "node:os";
import { basename, join } from "node:path";
import {
  detectSetupPlatform, ripgrepInstallCommand, tunnelAssetName, tunnelAssetUrl
} from "./setup-platform.mjs";
import { openUrl } from "./open-url.mjs";

const DEFAULT_TUNNEL_VERSION = process.env.TUNNEL_CLIENT_VERSION || "v0.0.10";
const TUNNEL_RELEASE_BASE = "https://github.com/openai/tunnel-client/releases/download";

export function createSetupRuntime(options) {
  const { capture, defaultTunnelBinForPlatform, KEY_URLS, MIN_NODE_MAJOR, promptYesNo, sha256 } = options;

  function printStep(index, total, title) {
    console.log(`\n[${index}/${total}] ${title}`);
  }

  function npmCommand() {
    return process.platform === "win32" ? "npm.cmd" : "npm";
  }

  async function commandAvailable(command) {
    const res = await capture(command, ["--version"]);
    return res.code === 0;
  }

  async function detectAvailableCommands(commands) {
    const found = [];
    for (const command of commands) {
      if (await commandAvailable(command)) found.push(command);
    }
    return found;
  }

  function ripgrepManualInstallHint(platform = detectSetupPlatform()) {
    if (platform.id === "darwin") return "Install manually: brew install ripgrep";
    if (platform.id === "win32") return "Install manually: winget install BurntSushi.ripgrep.MSVC";
    if (platform.id === "linux" || platform.id === "wsl") return "Install manually with your package manager, e.g. sudo apt-get install -y ripgrep";
    return "Install ripgrep from https://github.com/BurntSushi/ripgrep";
  }

  async function ensureRipgrep(platform = detectSetupPlatform()) {
    const existing = await capture(process.platform === "win32" ? "rg.exe" : "rg", ["--version"]);
    if (existing.code === 0) {
      console.log(`OK ${existing.stdout.split(/\r?\n/)[0]}`);
      return true;
    }
    console.log("WARN ripgrep not found; attempting install because it makes repo search much faster.");
    const candidates = platform.id === "darwin"
      ? ["brew"]
      : platform.id === "win32"
        ? ["winget"]
        : ["sudo", "apt-get", "dnf", "yum", "pacman", "zypper"];
    const install = ripgrepInstallCommand(platform, await detectAvailableCommands(candidates));
    if (!install) {
      console.log(`WARN no supported ripgrep installer found. ${ripgrepManualInstallHint(platform)}`);
      return false;
    }
    try {
      await runChecked("ripgrep", install.command, install.args);
    } catch (error) {
      console.log(`WARN ripgrep install via ${install.label} failed: ${error.message}`);
      console.log(ripgrepManualInstallHint(platform));
      return false;
    }
    const verify = await capture(process.platform === "win32" ? "rg.exe" : "rg", ["--version"]);
    if (verify.code === 0) {
      console.log(`OK ${verify.stdout.split(/\r?\n/)[0]}`);
      return true;
    }
    console.log(`WARN ripgrep install finished but rg is not on PATH. ${ripgrepManualInstallHint(platform)}`);
    return false;
  }

  async function checkPrerequisites(platform = detectSetupPlatform()) {
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    if (!Number.isInteger(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
      throw new Error(`Node.js ${MIN_NODE_MAJOR}+ is required. Current version: ${process.version}`);
    }
    console.log(`OK node ${process.version}`);
    const npm = await capture(npmCommand(), ["--version"]);
    if (npm.code !== 0) throw new Error("npm was not found. Install Node.js with npm, then rerun setup.");
    console.log(`OK npm ${npm.stdout.trim()}`);
    const git = await capture(process.platform === "win32" ? "git.exe" : "git", ["--version"]);
    console.log(git.code === 0 ? `OK ${git.stdout.trim()}` : "WARN git not found; repo-root detection will use the current folder.");
    await ensureRipgrep(platform);
  }

  async function openKeyPages(rl) {
    const shouldOpen = await promptYesNo(rl, "Open OpenAI Tunnel and Runtime API key pages now", true);
    if (!shouldOpen) {
      for (const url of KEY_URLS) console.log(url);
      return;
    }
    for (const url of KEY_URLS) {
      if (!openUrl(url)) console.log(url);
    }
  }

  function printInstructionMode(selected, host) {
    console.log(`\nThis terminal is ${host.label}, but you selected ${selected.label}.`);
    console.log("Instruction mode only: no setup commands were run for the other OS.");
    console.log("\nRun this on the target OS instead:");
    if (selected.id === "win32") console.log("  scripts\\lca-custom.cmd setup");
    else console.log("  bash scripts/lca-custom setup");
    console.log("\nExpected tunnel-client asset:");
    console.log(`  ${tunnelAssetName(DEFAULT_TUNNEL_VERSION, selected.tunnelOs, selected.arch)}`);
  }

  async function fetchBuffer(url) {
    const res = await fetch(url, { headers: { "User-Agent": "local-coding-agent-setup" } });
    if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async function fetchSha256ForAsset(version, assetName) {
    const url = `${TUNNEL_RELEASE_BASE}/${version}/SHA256SUMS.txt`;
    const res = await fetch(url, { headers: { "User-Agent": "local-coding-agent-setup" } });
    if (!res.ok) return "";
    const text = await res.text();
    for (const line of text.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const file = parts.slice(1).join(" ").replace(/^\*/, "");
      if (file === assetName) return parts[0].toLowerCase();
    }
    return "";
  }

  async function extractZip(zipPath, destDir) {
    mkdirSync(destDir, { recursive: true });
    if (process.platform === "win32") {
      const ps = await capture("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`
      ]);
      if (ps.code === 0) return;
      const pwsh = await capture("pwsh", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`
      ]);
      if (pwsh.code === 0) return;
      throw new Error("Could not extract zip with PowerShell.");
    }
    const unzip = await capture("unzip", ["-qo", zipPath, "-d", destDir]);
    if (unzip.code !== 0) throw new Error("Could not extract zip. Install unzip or provide tunnel-client manually.");
  }

  function findBinary(root, names) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const full = join(root, entry.name);
      if (entry.isDirectory()) {
        const found = findBinary(full, names);
        if (found) return found;
      } else if (names.includes(entry.name)) {
        return full;
      }
    }
    return "";
  }

  async function downloadTunnelClient(selected, destination = defaultTunnelBinForPlatform(selected)) {
    const version = process.env.TUNNEL_CLIENT_VERSION || DEFAULT_TUNNEL_VERSION;
    const assetName = tunnelAssetName(version, selected.tunnelOs, selected.arch);
    const url = tunnelAssetUrl(version, selected.tunnelOs, selected.arch);
    const tmp = mkdtempSync(join(os.tmpdir(), "lca-tunnel-"));
    try {
      mkdirSync(dirname(destination), { recursive: true });
      const zipPath = join(tmp, assetName);
      console.log(`Downloading ${assetName}`);
      const data = await fetchBuffer(url);
      const expected = await fetchSha256ForAsset(version, assetName);
      if (expected) {
        const actual = sha256(data);
        if (actual !== expected) throw new Error(`SHA256 mismatch for ${assetName}`);
        console.log("OK sha256 verified");
      } else {
        console.log("WARN SHA256SUMS entry not found; continuing without checksum verification.");
      }
      writeFileSync(zipPath, data);
      const extractDir = join(tmp, "extract");
      await extractZip(zipPath, extractDir);
      const binary = findBinary(extractDir, [selected.executable, "tunnel-client", "tunnel-client.exe"]);
      if (!binary) throw new Error(`Could not find ${selected.executable} inside ${assetName}`);
      writeFileSync(destination, readFileSync(binary));
      try { await chmod(destination, 0o755); } catch { /* Windows may ignore POSIX mode. */ }
      console.log(`Installed tunnel-client: ${destination}`);
      return destination;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }


  return { checkPrerequisites, downloadTunnelClient, openKeyPages, printInstructionMode, printStep };
}
