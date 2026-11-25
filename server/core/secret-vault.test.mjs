import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCommandRuntime } from "./command-runtime.mjs";
import { buildMacSecretPromptScript, createSecretVault } from "./secret-vault.mjs";

test("macOS secret prompt keeps dialog options together and return separate", () => {
  const script = buildMacSecretPromptScript('CMS "password"');
  assert.match(script, /display dialog .* default answer "" with hidden answer buttons \{"Cancel", "Save"\} default button "Save" cancel button "Cancel" with title "LCA Secret Input"\nreturn text returned of dialogResult/);
  assert.match(script, /CMS \\"password\\"/);
});

test("secret vault keeps values behind refs and redacts output", async () => {
  let captured;
  const vault = createSecretVault({
    now: () => 1_000,
    promptSecret: async ({ ref, label }) => {
      captured = { ref, label };
      return "s3cr3t-value";
    }
  });

  const stored = await vault.prompt({ ref: "cms.password", label: "CMS password" });
  assert.deepEqual(captured, { ref: "cms.password", label: "CMS password" });
  assert.equal(stored.ref, "cms.password");
  assert.equal(vault.resolve("cms.password"), "s3cr3t-value");
  assert.equal(vault.redactText("token=s3cr3t-value", ["s3cr3t-value"]), "token=[redacted secret]");
  assert.deepEqual(vault.status(), {
    storage: "memory-only",
    refs: [{ ref: "cms.password", expires_at: null }]
  });
  assert.equal(vault.forget("cms.password").forgotten, true);
  assert.throws(() => vault.resolve("cms.password"), /not loaded/);
});

test("command runtime injects and redacts secret env/stdin", async () => {
  const runtime = createCommandRuntime({
    MAX_COMMAND_OUTPUT: 20_000,
    PRIMARY_ROOT: process.cwd(),
    PROC_BUFFER: 20_000,
    appendLimited: (current, next, max) => (current + next).slice(-max),
    hasCommand: () => true,
    isoNow: () => new Date(0).toISOString(),
    processes: new Map()
  });
  const secret = "unit-secret-not-for-output";
  const envResult = await runtime.runShellCommand(
    "node -e \"process.stdout.write(process.env.LCA_TEST_SECRET); process.stderr.write(process.env.LCA_TEST_SECRET)\"",
    process.cwd(),
    "bash",
    10_000,
    { env: { LCA_TEST_SECRET: secret }, redactValues: [secret] }
  );
  assert.equal(envResult.exit_code, 0);
  assert.equal(envResult.stdout, "[redacted secret]");
  assert.equal(envResult.stderr, "[redacted secret]");

  const stdinResult = await runtime.runShellCommand(
    "node -e \"process.stdin.on('data', c => process.stdout.write(c))\"",
    process.cwd(),
    "bash",
    10_000,
    { stdin: secret, redactValues: [secret] }
  );
  assert.equal(stdinResult.exit_code, 0);
  assert.equal(stdinResult.stdout, "[redacted secret]");
});

test("foreground bash commands do not pay login-profile startup cost", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lca-shell-home-"));
  try {
    await writeFile(path.join(home, ".bash_profile"), "export LCA_PROFILE_PROBE=login-profile-loaded\n");
    const runtime = createCommandRuntime({
      MAX_COMMAND_OUTPUT: 20_000,
      PRIMARY_ROOT: process.cwd(),
      PROC_BUFFER: 20_000,
      appendLimited: (current, next, max) => (current + next).slice(-max),
      hasCommand: () => true,
      isoNow: () => new Date(0).toISOString(),
      processes: new Map()
    });
    const result = await runtime.runShellCommand(
      "printf '%s' \"\${LCA_PROFILE_PROBE:-clean}\"",
      process.cwd(),
      "bash",
      10_000,
      { env: { HOME: home, LCA_PROFILE_PROBE: "" } }
    );
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, "clean");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("secret vault expires refs without exposing values", async () => {
  let time = 10_000;
  const vault = createSecretVault({
    now: () => time,
    promptSecret: async () => "temporary"
  });
  await vault.prompt({ ref: "api.key", ttl_ms: 60_000 });
  assert.equal(vault.resolve("api.key"), "temporary");
  time += 60_001;
  assert.throws(() => vault.resolve("api.key"), /not loaded/);
  assert.deepEqual(vault.status().refs, []);
});
