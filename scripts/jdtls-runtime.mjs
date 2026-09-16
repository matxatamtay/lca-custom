// Local Coding Agent — isolated Eclipse JDT Language Server runtime
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const JDTLS_VERSION = "1.61.0";
export const JDTLS_ARCHIVE_URL = "https://www.eclipse.org/downloads/download.php?file=/jdtls/milestones/1.61.0/jdt-language-server-1.61.0-202609031315.tar.gz&r=1";
export const JDTLS_ARCHIVE_SHA256 = "338e7e73d61836651ba2453919a0d34fa763eb4e7c03342092309bffb8934c64";

export function createJdtLsRuntimePaths({
  repoRoot,
  platform = process.platform,
  version = JDTLS_VERSION
}) {
  const root = path.resolve(repoRoot);
  const baseDirectory = path.join(root, "runtime", "jdtls");
  const versionDirectory = path.join(baseDirectory, version);
  return {
    repoRoot: root,
    baseDirectory,
    versionDirectory,
    binaryPath: path.join(versionDirectory, "bin", platform === "win32" ? "jdtls.bat" : "jdtls"),
    manifestPath: path.join(versionDirectory, "lca-runtime.json")
  };
}

export function inspectJdtLsRuntime({ paths, version = JDTLS_VERSION, sha256 = JDTLS_ARCHIVE_SHA256 } = {}) {
  if (!paths) throw new Error("inspectJdtLsRuntime requires paths.");
  const manifest = readJson(paths.manifestPath, null);
  const binaryExists = existsSync(paths.binaryPath);
  const valid = binaryExists
    && manifest?.version === version
    && manifest?.archiveSha256 === sha256;
  return {
    installed: valid,
    version: valid ? version : manifest?.version ?? null,
    binaryPath: binaryExists ? paths.binaryPath : null,
    manifest: manifest ?? null,
    reason: valid
      ? null
      : !binaryExists
        ? `JDT LS binary is missing: ${paths.binaryPath}`
        : "JDT LS runtime manifest does not match the pinned version/checksum."
  };
}

export async function installJdtLsRuntime(options = {}) {
  const repoRoot = options.repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const paths = options.paths ?? createJdtLsRuntimePaths({
    repoRoot,
    platform: options.platform ?? process.platform,
    version: options.version ?? JDTLS_VERSION
  });
  const version = options.version ?? JDTLS_VERSION;
  const url = options.url ?? JDTLS_ARCHIVE_URL;
  const expectedSha256 = options.sha256 ?? JDTLS_ARCHIVE_SHA256;
  const fetchImpl = options.fetch ?? fetch;
  const run = options.run ?? runCommand;
  const log = options.log ?? (() => {});

  const current = inspectJdtLsRuntime({ paths, version, sha256: expectedSha256 });
  if (current.installed && options.force !== true) return { changed: false, paths, status: current };

  mkdirSync(paths.baseDirectory, { recursive: true });
  const workDirectory = path.join(paths.baseDirectory, `.install-${process.pid}-${Date.now()}`);
  const archivePath = path.join(workDirectory, "jdtls.tar.gz");
  const extractedDirectory = path.join(workDirectory, "extracted");

  try {
    mkdirSync(extractedDirectory, { recursive: true });
    log(`Downloading Eclipse JDT LS ${version}`);
    const response = await fetchImpl(url, {
      redirect: "follow",
      headers: { "User-Agent": "local-coding-agent-jdtls-installer" },
      signal: AbortSignal.timeout(options.downloadTimeoutMs ?? 120_000)
    });
    if (!response.ok) throw new Error(`JDT LS download failed with HTTP ${response.status}.`);
    const archive = Buffer.from(await response.arrayBuffer());
    const actualSha256 = createHash("sha256").update(archive).digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw new Error(`JDT LS checksum mismatch: ${actualSha256} (expected ${expectedSha256}).`);
    }
    writeFileSync(archivePath, archive, { mode: 0o600 });

    log("Extracting isolated JDT LS runtime");
    await run(resolveTarCommand(options.platform ?? process.platform), ["-xzf", archivePath, "-C", extractedDirectory], {
      cwd: workDirectory,
      timeoutMs: options.extractTimeoutMs ?? 120_000
    });

    const extractedBinary = path.join(extractedDirectory, "bin", (options.platform ?? process.platform) === "win32" ? "jdtls.bat" : "jdtls");
    if (!existsSync(extractedBinary)) throw new Error(`Extracted JDT LS binary is missing: ${extractedBinary}`);
    if ((options.platform ?? process.platform) !== "win32") chmodSync(extractedBinary, 0o755);
    writeFileSync(path.join(extractedDirectory, "lca-runtime.json"), `${JSON.stringify({
      schema: 1,
      version,
      archiveSha256: expectedSha256,
      source: url,
      installedAt: new Date().toISOString(),
      platform: options.platform ?? process.platform,
      arch: options.arch ?? process.arch
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    rmSync(paths.versionDirectory, { recursive: true, force: true });
    renameSync(extractedDirectory, paths.versionDirectory);
    const status = inspectJdtLsRuntime({ paths, version, sha256: expectedSha256 });
    if (!status.installed) throw new Error(status.reason || "JDT LS runtime verification failed after install.");
    return { changed: true, paths, status };
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
}

export function resolveTarCommand(platform = process.platform) {
  return platform === "win32" ? "tar.exe" : "tar";
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out.`));
    }, options.timeoutMs ?? 120_000);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, signal, stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed with exit ${code ?? signal}: ${stderr || stdout}`));
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? "status";
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const paths = createJdtLsRuntimePaths({ repoRoot });
  if (command === "install") {
    const result = await installJdtLsRuntime({ paths, log: (message) => console.log(message) });
    console.log(JSON.stringify(result.status, null, 2));
  } else {
    console.log(JSON.stringify(inspectJdtLsRuntime({ paths }), null, 2));
  }
}
