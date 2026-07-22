import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { AgentMemoryHttpAdapter } from "../adapters/agentmemory/agentmemory-http-adapter.js";
import { createDefaultCodeGraphAdapter } from "../adapters/codegraph/codegraph-adapter.js";
import { RipgrepFilesystemContextAdapter } from "../adapters/filesystem/ripgrep-filesystem-context-adapter.js";
import { BuildTaskContext } from "../application/context/build-task-context.js";

test("builds one context pack from filesystem, live CodeGraph, and AgentMemory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-context-integration-"));
  const memoryServer = http.createServer((request, response) => {
    if (request.url === "/agentmemory/smart-search" && request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        results: [{
          id: "mem-retry-policy",
          title: "Legacy retry policy",
          content: "Do not remove LegacyRetryPolicy because Partner X sends duplicate webhooks.",
          files: ["src/payment.ts"],
          score: 0.95
        }]
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => memoryServer.listen(0, "127.0.0.1", resolve));
  const address = memoryServer.address();
  assert.ok(address && typeof address === "object");

  const codegraph = createDefaultCodeGraphAdapter();
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "context-fixture", type: "module" }), "utf8");
    await writeFile(path.join(root, "src", "payment.ts"), [
      "export function legacyRetryPolicy(attempt: number): boolean {",
      "  return attempt < 3;",
      "}",
      "export function processWebhook(attempt: number): boolean {",
      "  return legacyRetryPolicy(attempt);",
      "}",
      ""
    ].join("\n"), "utf8");

    const useCase = new BuildTaskContext({
      filesystem: new RipgrepFilesystemContextAdapter(),
      codegraph,
      agentmemory: new AgentMemoryHttpAdapter({
        baseUrl: `http://127.0.0.1:${address.port}`,
        projectId: () => "context-fixture"
      })
    });

    const context = await useCase.execute({
      task: "Can LegacyRetryPolicy be removed from processWebhook?",
      root,
      budget: { maxItems: 12, maxChars: 30_000 }
    });

    assert.equal(context.coverage.filesystem.queried, true);
    assert.equal(context.coverage.codegraph.queried, true);
    assert.equal(context.coverage.agentmemory.queried, true);
    assert.ok(context.evidence.some((item) => item.provider === "filesystem"));
    assert.ok(context.evidence.some((item) => item.provider === "codegraph"));
    assert.ok(context.evidence.some((item) => item.provider === "agentmemory"));
    assert.match(context.evidence.find((item) => item.provider === "agentmemory")?.content ?? "", /duplicate webhooks/);
  } finally {
    await codegraph.close();
    await new Promise<void>((resolve, reject) => memoryServer.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
