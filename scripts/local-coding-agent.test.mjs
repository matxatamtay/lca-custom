import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  chooseManagedTunnelKeeper,
  isManagedTunnelArgv,
  mergeDotEnvText,
  normalize,
  normalizeProjectRoots,
  normalizeTunnelArch,
  parseDotEnv,
  ripgrepInstallCommand,
  setupSecurityDefaults,
  tunnelAssetName,
  tunnelAssetUrl
} from "./local-coding-agent.mjs";

test("normalizes isolated staging CLI port to 8790", () => {
  assert.equal(normalize({}).port, "8790");
});

test("normalizes and deduplicates multi-project roots", () => {
  const first = path.resolve("project-a");
  const second = path.resolve("project-b");
  assert.deepEqual(normalizeProjectRoots({
    workspace: first,
    extraRoots: `${second};${first}`
  }), [first, second]);
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

test("setup defaults to full mode and full policy unless flags override", () => {
  assert.deepEqual(setupSecurityDefaults({}), { mode: "full", policy: "full" });
  assert.deepEqual(setupSecurityDefaults({ mode: "safe", policy: "balanced" }), { mode: "safe", policy: "balanced" });
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
