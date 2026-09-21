import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverProjectRoots, resolveActiveProjectRoot } from "./project-root-discovery.mjs";

test("discovers nested projects and prefers server-like roots deterministically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-project-root-"));
  try {
    await mkdir(path.join(root, "server"), { recursive: true });
    await mkdir(path.join(root, "local-browser-agent"), { recursive: true });
    await writeFile(path.join(root, "server", "package.json"), "{}\n");
    await writeFile(path.join(root, "server", "tsconfig.json"), "{}\n");
    await writeFile(path.join(root, "local-browser-agent", "package.json"), "{}\n");
    const projects = await discoverProjectRoots(root);
    assert.equal(projects[0].root, path.join(root, "server"));
    const active = await resolveActiveProjectRoot({ workspaceRoot: root, requestedRoot: root });
    assert.equal(active.root, path.join(root, "server"));
    assert.equal(active.reason, "preferred_nested");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changed files route context to their nearest nested project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-project-changed-"));
  try {
    const app = path.join(root, "apps", "web");
    const server = path.join(root, "server");
    await mkdir(path.join(app, "src"), { recursive: true });
    await mkdir(path.join(server, "src"), { recursive: true });
    await writeFile(path.join(app, "package.json"), "{}\n");
    await writeFile(path.join(server, "package.json"), "{}\n");
    const changed = path.join(app, "src", "index.ts");
    await writeFile(changed, "export const x = 1;\n");
    const active = await resolveActiveProjectRoot({ workspaceRoot: root, requestedRoot: root, changedFiles: [changed] });
    assert.equal(active.root, app);
    assert.equal(active.reason, "changed_file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("falls back to requested root when no project manifests exist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-project-fallback-"));
  try {
    const active = await resolveActiveProjectRoot({ workspaceRoot: root, requestedRoot: root });
    assert.equal(active.root, root);
    assert.equal(active.reason, "fallback");
    assert.deepEqual(active.candidates, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
