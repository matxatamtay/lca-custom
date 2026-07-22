import test from "node:test";
import assert from "node:assert/strict";

import { CodeGraphAdapter } from "./codegraph-adapter.js";
import { PersistentMcpToolClient } from "../../infrastructure/mcp/persistent-mcp-tool-client.js";

test("syncs the project and maps live CodeGraph text into evidence", async () => {
  const calls: string[] = [];
  const client = new PersistentMcpToolClient(async () => ({
    async callTool(input) {
      calls.push(`${input.name}:${String(input.arguments.projectPath)}`);
      return {
        content: [{ type: "text", text: "Blast radius\nserver/src/example.ts" }]
      };
    },
    async close() {}
  }));
  const adapter = new CodeGraphAdapter({
    client,
    indexer: {
      async ensureIndexed(root) {
        calls.push(`index:${root}`);
      }
    }
  });

  await adapter.ensureIndexed("/repo");
  const evidence = await adapter.context({
    task: "Trace startup",
    root: "/repo",
    changedFiles: ["server.ts"],
    budget: { maxItems: 5 }
  });

  assert.deepEqual(calls, ["index:/repo", "codegraph_explore:/repo"]);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.provider, "codegraph");
  assert.match(evidence[0]?.content ?? "", /Blast radius/);
  assert.equal(evidence[0]?.metadata?.maxFiles, 5);
});

test("returns no evidence when CodeGraph has no text result", async () => {
  const adapter = new CodeGraphAdapter({
    client: new PersistentMcpToolClient(async () => ({
      async callTool() { return { content: [] }; },
      async close() {}
    })),
    indexer: { async ensureIndexed() {} }
  });

  assert.deepEqual(await adapter.context({ task: "Nothing", root: "/repo" }), []);
});
