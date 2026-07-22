import test from "node:test";
import assert from "node:assert/strict";

import {
  PersistentMcpToolClient,
  type McpToolConnection
} from "./persistent-mcp-tool-client.js";

test("deduplicates concurrent connection attempts", async () => {
  let connectionCount = 0;
  let releaseConnection: ((connection: McpToolConnection) => void) | undefined;
  const pending = new Promise<McpToolConnection>((resolve) => {
    releaseConnection = resolve;
  });
  const connection: McpToolConnection = {
    async callTool() { return { content: [{ type: "text", text: "ok" }] }; },
    async close() {}
  };
  const client = new PersistentMcpToolClient(async () => {
    connectionCount += 1;
    return pending;
  });

  const first = client.callTool("one", {});
  const second = client.callTool("two", {});
  releaseConnection?.(connection);

  await Promise.all([first, second]);
  assert.equal(connectionCount, 1);
});

test("reconnects once after a transport failure", async () => {
  let connectionCount = 0;
  let firstClosed = false;
  const client = new PersistentMcpToolClient(async () => {
    connectionCount += 1;
    if (connectionCount === 1) {
      return {
        async callTool() { throw new Error("transport connection closed"); },
        async close() { firstClosed = true; }
      };
    }
    return {
      async callTool() { return { content: [{ type: "text", text: "recovered" }] }; },
      async close() {}
    };
  });

  const result = await client.callTool("codegraph_explore", {});

  assert.equal(result.content?.[0]?.text, "recovered");
  assert.equal(connectionCount, 2);
  assert.equal(firstClosed, true);
});

test("does not reconnect for ordinary tool errors", async () => {
  let connectionCount = 0;
  const client = new PersistentMcpToolClient(async () => {
    connectionCount += 1;
    return {
      async callTool() { throw new Error("invalid project path"); },
      async close() {}
    };
  });

  await assert.rejects(client.callTool("codegraph_explore", {}), /invalid project path/);
  assert.equal(connectionCount, 1);
});
