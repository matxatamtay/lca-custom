import test from "node:test";
import assert from "node:assert/strict";

import {
  PersistentHttpMcpClient,
  PersistentHttpMcpClientRegistry,
  persistentHttpClientKey
} from "./persistent-http-mcp-client.mjs";

function toolList(name = "demo") {
  return { tools: [{ name, inputSchema: { type: "object", properties: {} } }] };
}

test("deduplicates concurrent connections and tools/list calls", async () => {
  let connectionCount = 0;
  let listCount = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = new PersistentHttpMcpClient({
    endpoint: "http://127.0.0.1:1/mcp",
    connectionFactory: async () => {
      connectionCount += 1;
      await gate;
      return {
        async listTools() { listCount += 1; return toolList(); },
        async callTool() { return { content: [{ type: "text", text: "ok" }] }; },
        async close() {}
      };
    }
  });

  const first = client.listTools();
  const second = client.listTools();
  release();
  const [left, right] = await Promise.all([first, second]);

  assert.equal(connectionCount, 1);
  assert.equal(listCount, 1);
  assert.equal(left, right);
});

test("caches tools and refreshes only when requested", async () => {
  let listCount = 0;
  const client = new PersistentHttpMcpClient({
    endpoint: "http://127.0.0.1:1/mcp",
    connectionFactory: async () => ({
      async listTools() { listCount += 1; return toolList(`demo-${listCount}`); },
      async callTool() { return {}; },
      async close() {}
    })
  });

  assert.equal((await client.listTools()).tools[0].name, "demo-1");
  assert.equal((await client.listTools()).tools[0].name, "demo-1");
  assert.equal((await client.listTools({ refresh: true })).tools[0].name, "demo-2");
  assert.equal(listCount, 2);
});

test("refreshes tool discovery once when a requested tool is missing", async () => {
  let listCount = 0;
  const client = new PersistentHttpMcpClient({
    endpoint: "http://127.0.0.1:1/mcp",
    connectionFactory: async () => ({
      async listTools() {
        listCount += 1;
        return listCount === 1 ? toolList("old") : toolList("new");
      },
      async callTool() { return {}; },
      async close() {}
    })
  });

  const found = await client.findTool("new");
  assert.equal(found.tool?.name, "new");
  assert.equal(listCount, 2);
});

test("reconnects once after a retryable transport failure", async () => {
  let connectionCount = 0;
  let firstClosed = false;
  const client = new PersistentHttpMcpClient({
    endpoint: "http://127.0.0.1:1/mcp",
    connectionFactory: async () => {
      connectionCount += 1;
      if (connectionCount === 1) {
        return {
          async listTools() { return toolList(); },
          async callTool() { throw new Error("transport connection closed"); },
          async close() { firstClosed = true; }
        };
      }
      return {
        async listTools() { return toolList(); },
        async callTool() { return { content: [{ type: "text", text: "recovered" }] }; },
        async close() {}
      };
    }
  });

  const result = await client.callTool({ name: "demo", arguments: {} });
  assert.equal(result.content[0].text, "recovered");
  assert.equal(connectionCount, 2);
  assert.equal(firstClosed, true);
});

test("does not reconnect ordinary tool errors", async () => {
  let connectionCount = 0;
  const client = new PersistentHttpMcpClient({
    endpoint: "http://127.0.0.1:1/mcp",
    connectionFactory: async () => {
      connectionCount += 1;
      return {
        async listTools() { return toolList(); },
        async callTool() { throw new Error("invalid request definition"); },
        async close() {}
      };
    }
  });

  await assert.rejects(client.callTool({ name: "demo", arguments: {} }), /invalid request definition/);
  assert.equal(connectionCount, 1);
});

test("registry keys do not expose bearer credentials and close every client", async () => {
  const key = persistentHttpClientKey({
    endpoint: "http://127.0.0.1:1/mcp",
    authToken: "super-secret-token",
    clientName: "demo"
  });
  assert.doesNotMatch(key, /super-secret-token/);

  const registry = new PersistentHttpMcpClientRegistry();
  let closes = 0;
  const create = () => ({ async close() { closes += 1; } });
  assert.equal(registry.get("one", create), registry.get("one", create));
  registry.get("two", create);
  assert.equal(registry.size, 2);
  await registry.closeAll();
  assert.equal(closes, 2);
  assert.equal(registry.size, 0);
});
