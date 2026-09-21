// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  tsDefinition,
  tsDiagnostics,
  tsOrganizeImports,
  tsReferences,
  tsRenameSymbol
} from "./typescript-code-intelligence.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-ts-intel-"));
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
    include: ["*.ts"]
  }), "utf8");
  await writeFile(path.join(root, "math.ts"), "export const add = (a: number, b: number) => a + b;\n", "utf8");
  await writeFile(path.join(root, "use.ts"), "import { add } from './math.js';\nimport { readFile } from 'node:fs/promises';\nexport const result = add(1, 2);\n", "utf8");
  return root;
}

test("finds TypeScript definitions and references with compiler-native locations", async () => {
  const root = await fixture();
  try {
    const definition = await tsDefinition({ root, file: "use.ts", symbol: "add" });
    assert.equal(definition.engine, "typescript-lsp");
    assert.ok(definition.definitions.some((item) => item.file.endsWith("math.ts")));

    const references = await tsReferences({ root, file: "math.ts", symbol: "add" });
    assert.ok(references.references.some((item) => item.file.endsWith("use.ts")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("previews and applies safe compiler-native rename edits", async () => {
  const root = await fixture();
  try {
    const preview = await tsRenameSymbol({ root, file: "math.ts", symbol: "add", newName: "sum" });
    assert.equal(preview.apply, false);
    assert.equal((await readFile(path.join(root, "math.ts"), "utf8")).includes("add"), true);

    const applied = await tsRenameSymbol({ root, file: "math.ts", symbol: "add", newName: "sum", apply: true });
    assert.equal(applied.apply, true);
    assert.match(await readFile(path.join(root, "use.ts"), "utf8"), /sum\(1, 2\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns structured diagnostics and organizes imports in preview mode", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, "bad.ts"), "const value: number = 'nope';\n", "utf8");
    const diagnostics = await tsDiagnostics({ root, file: "bad.ts" });
    assert.ok(diagnostics.diagnostics.some((item) => item.code === "TS2322"));

    const organized = await tsOrganizeImports({ root, file: "use.ts" });
    assert.equal(organized.apply, false);
    assert.ok(organized.edits >= 1);
    assert.match(await readFile(path.join(root, "use.ts"), "utf8"), /readFile/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
