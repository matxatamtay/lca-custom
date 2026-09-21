// Patch/edit regression coverage for the transactional-edit refactor.
// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { callCompactTool } from "./compact-test-client.mjs";

const SERVER = path.resolve("server.mjs");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, stderrRef) {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error(`Server did not become ready on port ${port}\n${stderrRef.value}`);
}

async function startServer(primaryRoot, extraRoots) {
  const port = await getFreePort();
  const stderrRef = { value: "" };
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_WORKSPACE: primaryRoot,
      AGENT_EXTRA_ROOTS_JSON: JSON.stringify(extraRoots),
      AGENTMEMORY_RECORD_SESSIONS: "0",
      AGENT_AUDIT: "0",
      MCP_AUTH_TOKEN: ""
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (chunk) => {
    stderrRef.value += chunk;
  });
  await waitForHealth(port, stderrRef);
  return { child, port, stderrRef };
}

async function stopServer(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
  await wait(250);
}

async function connect(port) {
  const client = new Client({ name: "edit-regression", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

async function callJson(client, name, args = {}) {
  const result = await callCompactTool(client, name, args);
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

async function callFailure(client, name, args = {}) {
  const result = await callCompactTool(client, name, args);
  const text = result.content?.[0]?.text ?? "";
  assert.equal(result.isError, true, `${name} unexpectedly succeeded: ${text}`);
  return text;
}

test("patch/edit behavior remains stable before transactional refactor", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lca-edit-regression-"));
  const primary = path.join(tempRoot, "primary-project");
  const secondary = path.join(tempRoot, "secondary-project");
  await mkdir(path.join(primary, "src"), { recursive: true });
  await mkdir(path.join(secondary, "lib"), { recursive: true });
  await writeFile(path.join(secondary, "lib", "peer.txt"), "peer-one\n", "utf8");

  let server;
  let client;
  try {
    server = await startServer(primary, [secondary]);
    client = await connect(server.port);

    await callJson(client, "task_plan", { goal: "Exercise transactional edit state", steps: ["edit files", "verify state"] });
    await callJson(client, "task_plan", {
      goal: "Exercise peer transactional edit state",
      steps: ["edit peer files", "verify peer state"],
      cwd: secondary
    });

    // Multi-workspace routing: existing relative path resolves to the unique peer.
    const peer = await callJson(client, "read_file", { path: "lib/peer.txt" });
    assert.equal(peer.path, path.join(secondary, "lib", "peer.txt"));
    assert.equal(peer.content, "peer-one\n");

    // New relative path follows the workspace with the deepest existing parent.
    const generatedWrite = await callJson(client, "write_file", { path: "lib/generated.txt", content: "generated\n" });
    assert.equal(await readFile(path.join(secondary, "lib", "generated.txt"), "utf8"), "generated\n");
    assert.equal(generatedWrite.post_edit?.summary?.files, 1);
    assert.equal(generatedWrite.post_edit?.roots?.[0]?.verification?.auto_run, false);
    const primaryCheckpoint = await callJson(client, "resume");
    assert.equal(primaryCheckpoint.reason, "task_plan");
    assert.equal(primaryCheckpoint.task.goal, "Exercise transactional edit state");
    assert.equal(primaryCheckpoint.task.changed_files.some((file) => file.endsWith("secondary-project/lib/generated.txt")), false);

    const editCheckpoint = await callJson(client, "resume", { cwd: secondary });
    assert.equal(editCheckpoint.version, 2);
    assert.equal(editCheckpoint.reason, "edit:write_file");
    assert.equal(editCheckpoint.task.goal, "Exercise peer transactional edit state");
    assert.ok(editCheckpoint.task.changed_files.some((file) => file.endsWith("secondary-project/lib/generated.txt")));

    // Structured create/update/rename/delete behavior.
    let result = await callJson(client, "apply_patch", {
      operations: [{ op: "create", path: "primary-project/src/item.txt", content: "alpha\n" }]
    });
    assert.equal(result.ok, true);
    assert.equal(await readFile(path.join(primary, "src", "item.txt"), "utf8"), "alpha\n");

    result = await callJson(client, "apply_patch", {
      operations: [{
        op: "update",
        path: "primary-project/src/item.txt",
        edits: [{ old_text: "alpha", new_text: "beta" }]
      }]
    });
    assert.equal(result.ok, true);
    assert.equal(await readFile(path.join(primary, "src", "item.txt"), "utf8"), "beta\n");

    result = await callJson(client, "apply_patch", {
      operations: [{ op: "rename", path: "primary-project/src/item.txt", rename_to: "primary-project/src/renamed.txt" }]
    });
    assert.equal(result.ok, true);
    assert.equal(await readFile(path.join(primary, "src", "renamed.txt"), "utf8"), "beta\n");

    result = await callJson(client, "apply_patch", {
      operations: [{ op: "delete", path: "primary-project/src/renamed.txt" }]
    });
    assert.equal(result.ok, true);
    await assert.rejects(readFile(path.join(primary, "src", "renamed.txt"), "utf8"));

    // Unified diff uses content matching and can target the uniquely matching peer workspace.
    result = await callJson(client, "apply_patch", {
      diff: [
        "--- a/lib/peer.txt",
        "+++ b/lib/peer.txt",
        "@@",
        "-peer-one",
        "+peer-two"
      ].join("\n")
    });
    assert.equal(result.ok, true);
    assert.equal(await readFile(path.join(secondary, "lib", "peer.txt"), "utf8"), "peer-two\n");

    // Preview is non-mutating.
    const preview = await callJson(client, "preview_patch", {
      operations: [{
        op: "update",
        path: "secondary-project/lib/peer.txt",
        edits: [{ old_text: "peer-two", new_text: "preview-only" }]
      }]
    });
    assert.equal(preview.ok, true);
    assert.equal(await readFile(path.join(secondary, "lib", "peer.txt"), "utf8"), "peer-two\n");

    // Undo restores modified content from the latest backup batch.
    await callJson(client, "replace_in_file", {
      path: "secondary-project/lib/peer.txt",
      old_text: "peer-two",
      new_text: "peer-three"
    });
    assert.equal(await readFile(path.join(secondary, "lib", "peer.txt"), "utf8"), "peer-three\n");
    const undoUpdate = await callJson(client, "undo_last_patch");
    assert.equal(undoUpdate.ok, true);
    assert.equal(await readFile(path.join(secondary, "lib", "peer.txt"), "utf8"), "peer-two\n");

    // Undo also removes a path that did not exist before the write.
    await callJson(client, "write_file", { path: "primary-project/src/temporary.txt", content: "temporary\n" });
    assert.equal(await readFile(path.join(primary, "src", "temporary.txt"), "utf8"), "temporary\n");
    const undoCreate = await callJson(client, "undo_last_patch");
    assert.equal(undoCreate.ok, true);
    await assert.rejects(readFile(path.join(primary, "src", "temporary.txt"), "utf8"));

    // Batch validation is transactional: one invalid edit aborts the whole batch before mutation.
    result = await callJson(client, "apply_patch", {
      operations: [
        {
          op: "update",
          path: "secondary-project/lib/peer.txt",
          edits: [{ old_text: "peer-two", new_text: "first-applied" }]
        },
        {
          op: "update",
          path: "secondary-project/lib/peer.txt",
          edits: [{ old_text: "definitely-missing", new_text: "never" }]
        },
        { op: "create", path: "primary-project/src/should-not-run.txt", content: "nope\n" }
      ]
    });
    assert.equal(result.ok, false);
    assert.equal(result.applied, 0);
    assert.equal(result.results.length, 3);
    assert.ok(result.results.every((entry) => entry.ok === false));
    assert.equal(await readFile(path.join(secondary, "lib", "peer.txt"), "utf8"), "peer-two\n");
    await assert.rejects(readFile(path.join(primary, "src", "should-not-run.txt"), "utf8"));

    // A commit-time failure also rolls back mutations that committed earlier in the same batch.
    const rollbackSource = path.join(primary, "src", "rollback-source.txt");
    const rollbackDestinationDirectory = path.join(primary, "src", "rollback-destination");
    await writeFile(rollbackSource, "source\n", "utf8");
    await mkdir(rollbackDestinationDirectory, { recursive: true });
    result = await callJson(client, "apply_patch", {
      operations: [
        {
          op: "update",
          path: "secondary-project/lib/peer.txt",
          edits: [{ old_text: "peer-two", new_text: "would-have-committed" }]
        },
        {
          op: "rename",
          path: "primary-project/src/rollback-source.txt",
          rename_to: "primary-project/src/rollback-destination"
        }
      ]
    });
    assert.equal(result.ok, false);
    assert.equal(result.applied, 0);
    assert.ok(result.results.every((entry) => /TRANSACTION_ROLLED_BACK/.test(entry.error || "")));
    assert.equal(await readFile(path.join(secondary, "lib", "peer.txt"), "utf8"), "peer-two\n");
    assert.equal(await readFile(rollbackSource, "utf8"), "source\n");
    assert.equal((await stat(rollbackDestinationDirectory)).isDirectory(), true);

    // read_file exposes a stable raw-byte SHA-256 that can guard later edits.
    await callJson(client, "write_file", { path: "primary-project/src/guarded.txt", content: "guarded-one\n" });
    const guardedRead = await callJson(client, "read_file", { path: "primary-project/src/guarded.txt" });
    assert.match(guardedRead.sha256, /^[a-f0-9]{64}$/);

    // A stale preimage hash must refuse the edit without mutating the externally changed file.
    await writeFile(path.join(primary, "src", "guarded.txt"), "external-change\n", "utf8");
    const staleError = await callFailure(client, "replace_in_file", {
      path: "primary-project/src/guarded.txt",
      old_text: "external-change",
      new_text: "agent-overwrite",
      expected_hash: guardedRead.sha256
    });
    assert.match(staleError, /STALE_FILE:/);
    assert.equal(await readFile(path.join(primary, "src", "guarded.txt"), "utf8"), "external-change\n");

    // The current hash succeeds and structured apply_patch honors the same preimage contract.
    const currentGuarded = await callJson(client, "read_file", { path: "primary-project/src/guarded.txt" });
    result = await callJson(client, "apply_patch", {
      operations: [{
        op: "update",
        path: "primary-project/src/guarded.txt",
        expected_hash: currentGuarded.sha256,
        edits: [{ old_text: "external-change", new_text: "guarded-two" }]
      }]
    });
    assert.equal(result.ok, true);
    assert.equal(await readFile(path.join(primary, "src", "guarded.txt"), "utf8"), "guarded-two\n");

    // Single replacements reject ambiguous matches unless replace_all is explicit.
    await callJson(client, "write_file", { path: "primary-project/src/ambiguous.txt", content: "same\nsame\n" });
    const ambiguousMatch = await callFailure(client, "replace_in_file", {
      path: "primary-project/src/ambiguous.txt",
      old_text: "same",
      new_text: "changed"
    });
    assert.match(ambiguousMatch, /AMBIGUOUS_MATCH:/);
    assert.equal(await readFile(path.join(primary, "src", "ambiguous.txt"), "utf8"), "same\nsame\n");

    // Conservative matching accepts line-ending-only drift and reports the strategy used.
    await writeFile(path.join(primary, "src", "crlf.txt"), "one\r\ntwo\r\n", "utf8");
    const normalized = await callJson(client, "replace_in_file", {
      path: "primary-project/src/crlf.txt",
      old_text: "one\ntwo",
      new_text: "ONE\nTWO"
    });
    assert.equal(normalized.match_strategy, "line_endings");
    assert.equal(await readFile(path.join(primary, "src", "crlf.txt"), "utf8"), "ONE\r\nTWO\r\n");

    // Text edits preserve a UTF-8 BOM as well as the file's existing line-ending style.
    const bomFile = path.join(primary, "src", "bom-crlf.txt");
    await writeFile(bomFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\r\ntwo\r\n", "utf8")]));
    await callJson(client, "replace_in_file", {
      path: "primary-project/src/bom-crlf.txt",
      old_text: "one\ntwo",
      new_text: "ONE\nTWO"
    });
    const bomRaw = await readFile(bomFile);
    assert.deepEqual([...bomRaw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(bomRaw.subarray(3).toString("utf8"), "ONE\r\nTWO\r\n");

    // Cross-root operations work when paths are project-qualified.
    await callJson(client, "apply_patch", {
      operations: [
        { op: "create", path: "primary-project/src/cross-primary.txt", content: "primary\n" },
        { op: "create", path: "secondary-project/lib/cross-secondary.txt", content: "secondary\n" }
      ]
    });
    assert.equal(await readFile(path.join(primary, "src", "cross-primary.txt"), "utf8"), "primary\n");
    assert.equal(await readFile(path.join(secondary, "lib", "cross-secondary.txt"), "utf8"), "secondary\n");

    // Ambiguous relative paths fail rather than silently targeting primary.
    await writeFile(path.join(primary, "shared.txt"), "primary\n", "utf8");
    await writeFile(path.join(secondary, "shared.txt"), "secondary\n", "utf8");
    const ambiguous = await callFailure(client, "replace_in_file", {
      path: "shared.txt",
      old_text: "primary",
      new_text: "wrong"
    });
    assert.match(ambiguous, /Ambiguous relative path 'shared\.txt'/);
  } finally {
    if (client) await client.close().catch(() => {});
    if (server) await stopServer(server.child);
    await rm(tempRoot, { recursive: true, force: true });
  }
});
