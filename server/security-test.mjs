// Trusted-local runtime regression tests.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { callCompactTool } from "./compact-test-client.mjs";

const ENDPOINT = process.env.TEST_ENDPOINT || "http://127.0.0.1:8799/mcp";
const AUDIT_LOG = process.env.AUDIT_LOG || path.resolve("data", "audit.log");
const client = new Client({ name: "trusted-runtime-test", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT)));

let pass = 0;
let fail = 0;
function check(label, condition, detail = "") {
  if (condition) {
    pass++;
    console.log("[PASS]", label);
  } else {
    fail++;
    console.log("[FAIL]", label, detail);
  }
}

async function call(name, args = {}) {
  const result = await callCompactTool(client, name, args);
  return { result, text: result.content?.[0]?.text ?? "" };
}

const infoResult = await call("workspace_info");
const info = JSON.parse(infoResult.text);
const root = path.resolve(info.primary_root);
check("runtime is trusted-local compact", info.runtime === "trusted-local" && info.tool_surface === "compact", infoResult.text);
check("removed policy fields stay absent", info.mode === undefined && info.policy === undefined && info.allow_dangerous === undefined, infoResult.text);

const tempRoot = path.resolve(os.tmpdir());
if (!root.startsWith(`${tempRoot}${path.sep}`) || !path.basename(root).startsWith("lca-security-")) {
  await client.close();
  throw new Error(`Refusing destructive regression outside isolated workspace: ${root}`);
}
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

// Absolute paths outside configured projects are intentionally supported.
const outside = path.join(os.tmpdir(), `lca-trusted-outside-${process.pid}.txt`);
await rm(outside, { force: true });
const absoluteWrite = await call("write_file", { path: outside, content: "trusted absolute path\n" });
check("absolute write outside configured roots succeeds", !absoluteWrite.result.isError, absoluteWrite.text);
const absoluteRead = await call("read_file", { path: outside });
check("absolute read outside configured roots succeeds", !absoluteRead.result.isError && JSON.parse(absoluteRead.text).content === "trusted absolute path\n", absoluteRead.text);
await call("delete_path", { path: outside });

// Git accepts ordinary global flags and mutations in the trusted runtime.
spawnSync("git", ["init"], { cwd: root, stdio: "ignore" });
spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
spawnSync("git", ["config", "user.name", "Test User"], { cwd: root, stdio: "ignore" });
await writeFile(path.join(root, "tracked.txt"), "one\n", "utf8");
spawnSync("git", ["add", "tracked.txt"], { cwd: root, stdio: "ignore" });
spawnSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
await writeFile(path.join(root, "tracked.txt"), "two\n", "utf8");
const configuredGit = await call("git", { args: ["-c", "color.ui=false", "status", "--short"] });
check("raw git accepts global configuration flags", !configuredGit.result.isError, configuredGit.text);
const restore = await call("git", { args: ["restore", "."] });
check("raw git mutations execute directly", !restore.result.isError, restore.text);
check("git restore changed the file", (await readFile(path.join(root, "tracked.txt"), "utf8")) === "one\n");

const nongit = path.join(os.tmpdir(), `lca-security-nongit-${process.pid}`);
await rm(nongit, { recursive: true, force: true });
await mkdir(nongit, { recursive: true });
const status = JSON.parse((await call("git_status", { cwd: nongit })).text);
check("git_status reports non-repositories honestly", status.is_git_repo === false && status.clean === null, JSON.stringify(status));

// Nested tool arguments are summarized without recording secrets.
const sentinel = `LCA_AUDIT_SECRET_${Date.now()}`;
await call("apply_patch", { operations: [{ op: "create", path: "audit-secret.txt", content: sentinel }] });
await new Promise((resolve) => setTimeout(resolve, 50));
const audit = await readFile(AUDIT_LOG, "utf8").catch(() => "");
check("audit log does not contain patch content", audit.length > 0 && !audit.includes(sentinel));

await client.close();
console.log(`\n==== TRUSTED RUNTIME: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
