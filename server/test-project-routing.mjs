import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, rm } from "node:fs/promises";

import { projectAliases, resolveProjectSelection, resolveTaskProjectRoot } from "./project-routing.mjs";

const roots = [
  path.resolve("/workspace/twa-verimie-app"),
  path.resolve("/workspace/lca-custom"),
  path.resolve("/workspace/verimie-internal-admin")
];

test("routes a task to a uniquely named configured project", () => {
  assert.equal(
    resolveTaskProjectRoot("Review the lca-custom project", roots),
    roots[1]
  );
});

test("routes a task through a unique distinctive project-name token", () => {
  const aliases = projectAliases(roots).get(roots[1]);
  assert.ok(aliases?.includes("lca"), JSON.stringify(aliases));
  assert.equal(
    resolveTaskProjectRoot("Plan improvements for LCA", roots),
    roots[1]
  );
});

test("generic tokens and absent project fail closed with peer roots", () => {
  assert.throws(() => resolveTaskProjectRoot("Fix the app navigation", roots), /Project not selected/);
  assert.throws(() => resolveTaskProjectRoot("Investigate this regression", roots), /Project not selected/);
  assert.equal(resolveTaskProjectRoot("Investigate this regression", [roots[0]]), roots[0]);
});

test("multiple mentions fail closed; an explicit scope takes precedence", () => {
  const task = "Compare lca-custom with verimie-internal-admin";
  assert.throws(() => resolveTaskProjectRoot(task, roots), /Ambiguous project/);
  assert.equal(resolveTaskProjectRoot(task, roots, roots[1]), roots[1]);
});

test("exact names beat incidental tokens and do not match longer repo names", () => {
  const extra = [...roots, path.resolve("/workspace/twa-verimie-app-brand"), path.resolve("/workspace/twa-blena-browser")];
  assert.equal(resolveTaskProjectRoot("Fix twa-blena-browser while debugging LCA", extra), extra[4]);
  assert.equal(resolveTaskProjectRoot("Fix twa-verimie-app-brand.", extra), extra[3]);
});

test("explicit selection validates basename, unique suffix, absolute folder and unknown names", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-route-"));
  const a = path.join(dir, "a", "duplicate");
  const b = path.join(dir, "b", "duplicate");
  const c = path.join(dir, "twa-blena-browser");
  try {
    await Promise.all([a,b,c].map(root => mkdir(root,{recursive:true})));
    const configured = [a,b,c];
    assert.equal(resolveProjectSelection("twa-blena-browser", configured), c);
    assert.equal(resolveProjectSelection("a/duplicate", configured), a);
    assert.equal(resolveTaskProjectRoot("Inspect a/duplicate", configured), a);
    assert.throws(() => resolveTaskProjectRoot("Inspect duplicate", configured), /Ambiguous project/);
    assert.equal(resolveProjectSelection(dir, configured), dir);
    assert.throws(() => resolveProjectSelection("duplicate", configured), /Ambiguous project/);
    assert.throws(() => resolveProjectSelection("typo", configured), /Unknown project/);
    assert.throws(() => resolveProjectSelection(path.join(dir,"missing"), configured), /does not exist/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
