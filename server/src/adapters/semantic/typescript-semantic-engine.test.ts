import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TypeScriptSemanticEngine } from "./typescript-semantic-engine.js";

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-ts-semantic-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true
    },
    include: ["src/**/*.ts"]
  }), "utf8");
  await writeFile(path.join(root, "src", "service.ts"), [
    "export class PaymentService {",
    "  charge(amount: number): number {",
    "    return amount;",
    "  }",
    "}",
    ""
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "src", "consumer.ts"), [
    "import { PaymentService } from './service.js';",
    "export function checkout(service: PaymentService): number {",
    "  return service.charge(42);",
    "}",
    ""
  ].join("\n"), "utf8");
  return root;
}

test("returns bounded semantic definitions and references for a TypeScript symbol", async () => {
  const root = await createFixture();
  const engine = new TypeScriptSemanticEngine();
  try {
    const evidence = await engine.context({
      task: "Trace PaymentService callers and references",
      root,
      budget: { maxItems: 4, maxChars: 8_000 }
    });

    const payment = evidence.find((item) => item.symbol === "PaymentService");
    assert.ok(payment, JSON.stringify(evidence, null, 2));
    assert.equal(payment.provider, "semantic");
    assert.equal(payment.metadata?.engine, "typescript-7-native-api");
    assert.match(payment.content, /src\/service\.ts:/);
    assert.match(payment.content, /src\/consumer\.ts:/);
    assert.ok((payment.metadata?.reference_count as number) >= 1);
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshes the persistent TypeScript session after a source change", async () => {
  const root = await createFixture();
  const engine = new TypeScriptSemanticEngine();
  try {
    await engine.context({ task: "Trace PaymentService", root });
    await writeFile(path.join(root, "src", "second-consumer.ts"), [
      "import { PaymentService } from './service.js';",
      "export const secondary = new PaymentService();",
      ""
    ].join("\n"), "utf8");

    const evidence = await engine.context({
      task: "Trace PaymentService",
      root,
      changedFiles: ["src/second-consumer.ts"]
    });
    const payment = evidence.find((item) => item.symbol === "PaymentService");
    assert.ok(payment, JSON.stringify(evidence, null, 2));
    assert.match(payment.content, /second-consumer\.ts:/);
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});
