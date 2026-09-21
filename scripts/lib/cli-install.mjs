import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";

export function createCliInstaller(options) {
  const { CLI_NAME, CONFIG_PATH, REPO_ROOT, SCRIPT_DIR, capture } = options;

  function defaultCliBinDir() {
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    if (process.platform === "win32") {
      return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "LocalCodingAgentCustom", "bin");
    }
    return join(home, ".local", "bin");
  }

  function canWriteDir(dir) {
    try {
      mkdirSync(dir, { recursive: true });
      const probe = join(dir, `.lca-custom-write-test-${process.pid}`);
      writeFileSync(probe, "");
      rmSync(probe, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  function cliBinCandidates() {
    if (process.env.LCA_CUSTOM_BIN_DIR) return [process.env.LCA_CUSTOM_BIN_DIR];
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    if (process.platform === "win32") return [defaultCliBinDir()];
    return [
      defaultCliBinDir(),
      join(home, "bin"),
      join(dirname(CONFIG_PATH), "bin")
    ];
  }

  function chooseCliBinDir() {
    for (const dir of cliBinCandidates()) {
      if (canWriteDir(dir)) return dir;
    }
    return defaultCliBinDir();
  }

  function pathEnvKey() {
    return Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";
  }

  function getProcessPath() {
    return process.env[pathEnvKey()] || "";
  }

  function setProcessPath(value) {
    const key = pathEnvKey();
    process.env[key] = value;
    process.env.PATH = value;
  }

  function prependProcessPath(dir) {
    const current = getProcessPath();
    const sep = process.platform === "win32" ? ";" : ":";
    setProcessPath(current ? `${dir}${sep}${current}` : dir);
  }

  function normalizePathForCompare(value) {
    const resolved = resolve(String(value || ""));
    return process.platform === "win32"
      ? resolved.replace(/[\\/]+$/, "").toLowerCase()
      : resolved;
  }

  function pathHasDir(dir) {
    const target = normalizePathForCompare(dir);
    return getProcessPath()
      .split(process.platform === "win32" ? ";" : ":")
      .some((entry) => entry && normalizePathForCompare(entry) === target);
  }

  function shellProfileCandidates() {
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    const shell = basename(process.env.SHELL || "");
    if (shell === "zsh") return [join(home, ".zshrc")];
    if (shell === "fish") return [join(home, ".config", "fish", "config.fish")];
    if (shell === "bash") {
      if (process.platform === "darwin") return [join(home, ".bash_profile"), join(home, ".bashrc")];
      return [join(home, ".bashrc"), join(home, ".profile")];
    }
    return [join(home, ".zshrc"), join(home, ".bashrc"), join(home, ".profile")];
  }

  function pathExportLine(dir, profilePath) {
    if (profilePath.endsWith("config.fish")) return `fish_add_path "${dir}"`;
    return `export PATH="${dir}:$PATH"`;
  }

  async function setWindowsUserPath(binDir) {
    const script = `
  $ErrorActionPreference = 'Stop'
  $dir = [System.IO.Path]::GetFullPath($args[0])
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($null -eq $userPath) { $userPath = '' }
  $exists = $false
  foreach ($part in ($userPath -split ';')) {
    if ([string]::IsNullOrWhiteSpace($part)) { continue }
    try { $full = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($part)) } catch { $full = $part }
    if ($full.TrimEnd('\\') -ieq $dir.TrimEnd('\\')) { $exists = $true; break }
  }
  if (-not $exists) {
    $newPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $dir } else { "$userPath;$dir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Output 'added'
  } else {
    Write-Output 'exists'
  }
  `;
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script, binDir];
    let result = await capture("powershell.exe", args);
    if (result.code !== 0) result = await capture("pwsh", ["-NoProfile", "-Command", script, binDir]);
    return result;
  }

  async function configureShellPath(binDir) {
    if (pathHasDir(binDir)) return { changed: false, active: true, profile: "" };
    if (process.platform === "win32") {
      prependProcessPath(binDir);
      const result = await setWindowsUserPath(binDir);
      if (result.code === 0) {
        const changed = result.stdout.includes("added");
        return {
          changed,
          active: false,
          profile: "User PATH",
          message: `${changed ? "Added" : "Already present in"} Windows User PATH: ${binDir}. Open a new terminal before running lca-custom.`
        };
      }
      return {
        changed: false,
        active: false,
        profile: "",
        message: `Could not update Windows User PATH automatically. Add this directory manually: ${binDir}`
      };
    }

    const profile = shellProfileCandidates()[0];
    mkdirSync(dirname(profile), { recursive: true });
    const existing = existsSync(profile) ? readFileSync(profile, "utf8") : "";
    const line = pathExportLine(binDir, profile);
    if (!existing.includes(binDir) && !existing.includes(line)) {
      const block = `\n# Local Coding Agent CLI\n${line}\n`;
      writeFileSync(profile, `${existing.replace(/\s*$/, "")}${block}`, "utf8");
    }
    prependProcessPath(binDir);
    return { changed: true, active: false, profile, message: `Added ${binDir} to ${profile}. Restart your terminal or run: source ${profile}` };
  }

  async function verifyCliShim(cliPath) {
    const result = process.platform === "win32"
      ? await capture("cmd.exe", ["/d", "/c", `call "${cliPath}" --help`], { cwd: REPO_ROOT })
      : await capture(cliPath, ["--help"], { cwd: REPO_ROOT });
    if (result.code !== 0) {
      throw new Error(`Installed ${CLI_NAME} wrapper failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
    }
    console.log(`OK ${CLI_NAME} wrapper: ${cliPath}`);
  }

  function bashSingleQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
  }

  function powershellSingleQuote(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  function batchQuotedValue(value) {
    return String(value).replace(/%/g, "%%");
  }

  function cliWrapperContents({ marker, scriptPath, configPath }) {
    const bash = `#!/usr/bin/env bash\n# ${marker}\nexport LCA_CUSTOM_CONFIG_PATH=${bashSingleQuote(configPath)}\nexec node ${bashSingleQuote(scriptPath)} "$@"\n`;
    const cmd = `@echo off\r\nrem ${marker}\r\nwhere node >nul 2>nul\r\nif errorlevel 1 (\r\n  echo ERROR: Node.js 20+ is required but node was not found in PATH.\r\n  echo Install Node.js LTS from https://nodejs.org/ then open a new terminal and rerun setup.\r\n  exit /b 1\r\n)\r\nset "LCA_CUSTOM_CONFIG_PATH=${batchQuotedValue(configPath)}"\r\nnode "${batchQuotedValue(scriptPath)}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
    const powershell = `# ${marker}\n$env:LCA_CUSTOM_CONFIG_PATH = ${powershellSingleQuote(configPath)}\n& node ${powershellSingleQuote(scriptPath)} @args\nexit $LASTEXITCODE\n`;
    return { bash, cmd, powershell };
  }

  async function installCliCommand() {
    const marker = `local-coding-agent ${CLI_NAME} wrapper`;
    const wrapper = cliWrapperContents({
      marker,
      scriptPath: join(SCRIPT_DIR, "local-coding-agent.mjs"),
      configPath: CONFIG_PATH
    });
    const preferredBinDir = process.env.LCA_CUSTOM_BIN_DIR || defaultCliBinDir();
    const binDir = chooseCliBinDir();
    if (binDir !== preferredBinDir) {
      console.log(`WARN ${preferredBinDir} is not writable; installing ${CLI_NAME} into ${binDir} instead.`);
    }
    mkdirSync(binDir, { recursive: true });
    if (process.platform === "win32") {
      const cmdPath = join(binDir, `${CLI_NAME}.cmd`);
      const psPath = join(binDir, `${CLI_NAME}.ps1`);
      for (const target of [cmdPath, psPath]) {
        if (existsSync(target) && !readFileSync(target, "utf8").includes(marker)) {
          throw new Error(`Refusing to overwrite: ${target}`);
        }
      }
      writeFileSync(cmdPath, wrapper.cmd, "utf8");
      writeFileSync(psPath, wrapper.powershell, "utf8");
      console.log(`Installed: ${cmdPath}`);
      const pathResult = await configureShellPath(binDir);
      if (pathResult.message) console.log(pathResult.message);
      if (!pathResult.active) console.log(`Current terminal fallback: "${cmdPath}"`);
      return cmdPath;
    }
    const target = join(binDir, CLI_NAME);
    if (existsSync(target) && !readFileSync(target, "utf8").includes(marker)) {
      throw new Error(`Refusing to overwrite: ${target}`);
    }
    writeFileSync(target, wrapper.bash, "utf8");
    await chmod(target, 0o755);
    console.log(`Installed: ${target}`);
    const pathResult = await configureShellPath(binDir);
    if (pathResult.message) console.log(pathResult.message);
    return target;
  }


  return { cliWrapperContents, installCliCommand };
}
