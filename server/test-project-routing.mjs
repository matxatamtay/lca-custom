import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import { projectAliases, resolveTaskProjectRoot } from "./project-routing.mjs";

const roots = [
  path.resolve("/workspace/twa-verimie-app"),
  path.resolve("/workspace/lca-custom"),
  path.resolve("/workspace/verimie-internal-admin")
];

test("routes a task to a uniquely named configured project", () => {
  assert.equal(
    resolveTaskProjectRoot("Review the lca-custom project", roots, roots[0]),
    roots[1]
  );
});

test("routes a task through a unique distinctive project-name token", () => {
  const aliases = projectAliases(roots).get(roots[1]);
  assert.ok(aliases?.includes("lca"), JSON.stringify(aliases));
  assert.equal(
    resolveTaskProjectRoot("Plan improvements for LCA", roots, roots[0]),
    roots[1]
  );
});

test("does not route on generic project-name tokens", () => {
  assert.equal(
    resolveTaskProjectRoot("Fix the app navigation", roots, roots[0]),
    roots[0]
  );
});

test("falls back to primary when multiple configured projects are mentioned", () => {
  assert.equal(
    resolveTaskProjectRoot("Compare lca-custom with verimie-internal-admin", roots, roots[0]),
    roots[0]
  );
});

test("falls back to primary when no configured project is mentioned", () => {
  assert.equal(
    resolveTaskProjectRoot("Investigate this regression", roots, roots[0]),
    roots[0]
  );
});
