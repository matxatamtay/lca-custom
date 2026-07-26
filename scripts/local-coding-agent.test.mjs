import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  chooseManagedTunnelKeeper,
  hashDirectoryTree,
  isManagedTunnelArgv,
  nextRuntimeBuildSpec,
  parseArgs,
  mergeDotEnvText,
  normalize,
  normalizeProjectRoots,
  normalizeTunnelArch,
  promoteProjectRoot,
  cliWrapperContents,
  parseDotEnv,
  ripgrepInstallCommand,
  tunnelAssetName,
  tunnelAssetUrl
} from "./local-coding-agent.mjs";

test("normalizes trusted compact runtime defaults", () => {
  const value = normalize({ mode: "safe", policy: "strict", surface: "legacy" });
  assert.equal(value.port, "8790");
  assert.equal(Object.hasOwn(value, "mode"), false);
  assert.equal(Object.hasOwn(value, "policy"), false);
  assert.equal(Object.hasOwn(value, "surface"), false);
});

test("normalizes and deduplicates multi-project roots", () => {
  const first = path.resolve("project-a");
  const second = path.resolve("project-b");
  assert.deepEqual(normalizeProjectRoots({
    workspace: first,
    extraRoots: `${second};${first}`
  }), [first, second]);
});

test("promotes one project without dropping the remaining roots", () => {
  const first = path.resolve("project-a");
  const second = path.resolve("project-b");
  const third = path.resolve("project-c");
  assert.deepEqual(promoteProjectRoot([first, second, third], second), [second, first, third]);
});

test("normalize keeps the primary project first and derives extra roots", () => {
  const first = path.resolve("project-a");
  const second = path.resolve("project-b");
  const value = normalize({ projects: [first, second], workspace: first });
  assert.deepEqual(value.projects, [first, second]);
  assert.equal(value.workspace, first);
  assert.equal(value.extraRoots, second);
});

test("matches only the exact managed tunnel command", () => {
  const opts = {
    tunnelBin: path.resolve("tools/tunnel-client"),
    profile: "local-coding-agent",
    profileDir: path.resolve("tools/profiles"),
    tunnelId: "tunnel_demo"
  };
  const argv = [
    opts.tunnelBin,
    "run",
    "--profile", opts.profile,
    "--profile-dir", opts.profileDir,
    "--control-plane.tunnel-id", opts.tunnelId
  ];
  assert.equal(isManagedTunnelArgv(argv, opts), true);
  assert.equal(isManagedTunnelArgv([...argv.slice(0, -1), "tunnel_other"], opts), false);
  assert.equal(isManagedTunnelArgv(["/tmp/other-tunnel", ...argv.slice(1)], opts), false);
});

test("reuses only the remembered tunnel for the current config", () => {
  const processes = [{ pid: 101 }, { pid: 202 }];
  assert.deepEqual(
    chooseManagedTunnelKeeper(processes, { tunnelPid: 202, configId: "same", port: "8789" }, { configId: "same", port: "8789" }),
    { pid: 202 }
  );
  assert.equal(
    chooseManagedTunnelKeeper(processes, { tunnelPid: 202, configId: "old", port: "8789" }, { configId: "same", port: "8789" }),
    null
  );
  assert.equal(
    chooseManagedTunnelKeeper(processes, { tunnelPid: 202, configId: "same", port: "8790" }, { configId: "same", port: "8789" }),
    null
  );
});

test("maps tunnel-client release assets for supported platforms", () => {
  assert.equal(tunnelAssetName("v0.0.10", "darwin", "arm64"), "tunnel-client-v0.0.10-darwin-arm64.zip");
  assert.equal(tunnelAssetName("v0.0.10", "linux", "x64"), "tunnel-client-v0.0.10-linux-amd64.zip");
  assert.equal(tunnelAssetName("v0.0.10", "windows", "amd64"), "tunnel-client-v0.0.10-windows-amd64.zip");
  assert.equal(
    tunnelAssetUrl("v0.0.10", "windows", "arm64"),
    "https://github.com/openai/tunnel-client/releases/download/v0.0.10/tunnel-client-v0.0.10-windows-arm64.zip"
  );
});

test("normalizes supported CPU architectures", () => {
  assert.equal(normalizeTunnelArch("x64"), "amd64");
  assert.equal(normalizeTunnelArch("amd64"), "amd64");
  assert.equal(normalizeTunnelArch("aarch64"), "arm64");
  assert.equal(normalizeTunnelArch("arm64"), "arm64");
  assert.throws(() => normalizeTunnelArch("ia32"), /Unsupported CPU architecture/);
});

test("parses and merges dotenv without dropping unrelated values", () => {
  const existing = "KEEP=1\nCONTROL_PLANE_TUNNEL_ID=tunnel_old\n";
  const merged = mergeDotEnvText(existing, {
    CONTROL_PLANE_TUNNEL_ID: "tunnel_new",
    CONTROL_PLANE_API_KEY: "sk-proj-new"
  });
  assert.deepEqual(parseDotEnv(merged), {
    KEEP: "1",
    CONTROL_PLANE_TUNNEL_ID: "tunnel_new",
    CONTROL_PLANE_API_KEY: "sk-proj-new"
  });
});

test("empty dotenv merge starts with the requested key", () => {
  const merged = mergeDotEnvText("", { CONTROL_PLANE_TUNNEL_ID: "tunnel_new" });
  assert.equal(merged, "CONTROL_PLANE_TUNNEL_ID=tunnel_new\n");
});

test("dotenv parser preserves Coolify tokens containing shell metacharacters", () => {
  const key = ["COOLIFY", "MCP", "AUTH", "TOKEN"].join("_");
  const opaqueValue = "prefix$segment;tail&more";
  assert.deepEqual(parseDotEnv(`${key}=${opaqueValue}\n`), { [key]: opaqueValue });
});

test("selects ripgrep install command by platform", () => {
  assert.deepEqual(ripgrepInstallCommand({ id: "darwin" }, ["brew"]), {
    label: "Homebrew",
    command: "brew",
    args: ["install", "ripgrep"]
  });
  assert.deepEqual(ripgrepInstallCommand({ id: "win32" }, ["winget"]), {
    label: "winget",
    command: "winget",
    args: ["install", "--id", "BurntSushi.ripgrep.MSVC", "-e"]
  });
  const linux = ripgrepInstallCommand({ id: "linux" }, ["apt-get"]);
  assert.equal(linux.label, "apt-get");
  assert.match(`${linux.command} ${linux.args.join(" ")}`, /apt-get .*install -y ripgrep|apt-get install -y ripgrep/);
  assert.equal(ripgrepInstallCommand({ id: "linux" }, []), null);
});


test("hashes runtime build directories deterministically and detects changes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lca-runtime-hash-"));
  try {
    mkdirSync(path.join(root, "nested"), { recursive: true });
    writeFileSync(path.join(root, "b.js"), "export const b = 2;\n");
    writeFileSync(path.join(root, "nested", "a.js"), "export const a = 1;\n");
    const first = hashDirectoryTree(root);
    const second = hashDirectoryTree(root);
    assert.equal(first, second);
    writeFileSync(path.join(root, "nested", "a.js"), "export const a = 3;\n");
    assert.notEqual(hashDirectoryTree(root), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("selects the deterministic TypeScript build command by platform", () => {
  assert.deepEqual(nextRuntimeBuildSpec("linux").args, ["run", "build:next"]);
  assert.equal(nextRuntimeBuildSpec("linux").command, "npm");
  assert.equal(nextRuntimeBuildSpec("win32").command, "npm.cmd");
  assert.match(nextRuntimeBuildSpec("linux").cwd, /server$/);
});


test("CLI wrappers pin the source and isolated config on every shell", () => {
  const wrapper = cliWrapperContents({
    marker: "local-coding-agent lca-custom wrapper",
    scriptPath: "/tmp/LCA next/scripts/local-coding-agent.mjs",
    configPath: "/tmp/Config's Next/cli-config.json"
  });
  assert.match(wrapper.bash, /export LCA_CUSTOM_CONFIG_PATH=/);
  assert.match(wrapper.bash, /Config'\\''s Next/);
  assert.match(wrapper.bash, /LCA next\/scripts\/local-coding-agent\.mjs/);
  assert.match(wrapper.cmd, /set "LCA_CUSTOM_CONFIG_PATH=/);
  assert.match(wrapper.powershell, /\$env:LCA_CUSTOM_CONFIG_PATH/);
  assert.match(wrapper.powershell, /Config''s Next/);
});

test("parses TUI and primary project commands", () => {
  assert.deepEqual(parseArgs(["tui"]), { command: "tui", rest: [], flags: {} });
  assert.deepEqual(parseArgs(["primary", "/tmp/project"]), { command: "primary", rest: ["/tmp/project"], flags: {} });
});

test("parses AgentMemory portability command flags", () => {
  const parsed = parseArgs([
    "memory",
    "import",
    "backup.json",
    "--dry-run",
    "--strategy",
    "merge",
    "--json"
  ]);
  assert.equal(parsed.command, "memory");
  assert.deepEqual(parsed.rest, ["import", "backup.json"]);
  assert.equal(parsed.flags.dryRun, true);
  assert.equal(parsed.flags.strategy, "merge");
  assert.equal(parsed.flags.json, true);
});
