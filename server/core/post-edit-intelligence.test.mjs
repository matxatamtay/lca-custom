import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPostEditIntelligence } from "./post-edit-intelligence.mjs";

test("post-edit intelligence formats, re-reads, reports semantic diagnostics, and only recommends gates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-post-edit-"));
  const file = path.join(root, "src", "a.ts");
  await writeFile(file, "const a=1;\n", { encoding: "utf8", flag: "w" }).catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "const a=1;\n", "utf8");
  });
  const calls = [];
  const postEdit = createPostEditIntelligence({
    resolveProjectRoot: () => root,
    resolveFormatter: async () => ({ engine: "fake", command: "fake-format", displayCommand: "fake-format src/a.ts" }),
    runShellCommand: async (command, cwd) => {
      calls.push({ command, cwd });
      await writeFile(file, "const a = 1;\n", "utf8");
      return { exit_code: 0, stdout: "", stderr: "", timed_out: false };
    },
    getNextApplicationRuntime: async () => ({
      application: {
        semantic: {
          diagnostics: async () => ({
            diagnostics: [{ path: "src/a.ts", line: 1, column: 1, severity: "warning", code: 123, message: "demo" }],
            language: "typescript", engine: "fake-ts", available: true, state: "ready", fresh: true
          })
        }
      }
    }),
    getTestCommandsMerged: async () => ({ lint: "lint", typecheck: "types", test: "test", build: "build" })
  });

  const result = await postEdit.analyze([file]);
  assert.equal(calls.length, 1);
  assert.equal(result.roots[0].formatter.status, "pass");
  assert.equal(result.roots[0].semantic.counts.warning, 1);
  assert.deepEqual(result.roots[0].verification.suggested_gates, ["lint", "typecheck", "test"]);
  assert.equal(result.roots[0].verification.auto_run, false);
  assert.match(result.changed_files[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(file, "utf8"), "const a = 1;\n");
  await rm(root, { recursive: true, force: true });
});

test("formatter and semantic failures are metadata only after the edit is committed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-post-edit-fail-"));
  const file = path.join(root, "a.dart");
  await writeFile(file, "void main() {}\n", "utf8");
  const postEdit = createPostEditIntelligence({
    resolveProjectRoot: () => root,
    resolveFormatter: async () => ({ engine: "fake", command: "bad-format" }),
    runShellCommand: async () => ({ exit_code: 2, stdout: "", stderr: "formatter broke", timed_out: false }),
    getNextApplicationRuntime: async () => { throw new Error("semantic offline"); },
    getTestCommandsMerged: async () => ({ test: "flutter test" })
  });

  const result = await postEdit.analyze([file]);
  assert.equal(result.roots[0].formatter.status, "fail");
  assert.equal(result.roots[0].semantic.status, "unavailable");
  assert.deepEqual(result.roots[0].verification.suggested_gates, ["test"]);
  assert.equal(await readFile(file, "utf8"), "void main() {}\n");
  await rm(root, { recursive: true, force: true });
});

test("no detected formatter is a clean skip", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-post-edit-skip-"));
  const file = path.join(root, "notes.txt");
  await writeFile(file, "hello\n", "utf8");
  const postEdit = createPostEditIntelligence({
    resolveProjectRoot: () => root,
    runShellCommand: async () => { throw new Error("must not run"); },
    getNextApplicationRuntime: async () => ({ application: { semantic: {} } }),
    getTestCommandsMerged: async () => ({})
  });
  const result = await postEdit.analyze([file]);
  assert.equal(result.roots[0].formatter.status, "skipped");
  assert.equal(result.roots[0].verification.auto_run, false);
  await rm(root, { recursive: true, force: true });
});
