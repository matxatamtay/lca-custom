// Local Coding Agent — Penpot MCP bridge tests
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";

import {
  assertPenpotPolicy,
  callDestructivePenpotTool,
  callMutatingPenpotTool,
  callReadOnlyPenpotTool,
  classifyPenpotTool,
  friendlyPenpotError,
  inspectPenpotPage,
  inspectPenpotSelection,
  normalizePenpotEndpoint,
  penpotConnectionEndpoint,
  penpotStatus,
  redactPenpotSecrets
} from "./penpot-desktop.mjs";

const tools = [
  { name: "high_level_overview", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } },
  { name: "penpot_api_info", inputSchema: { type: "object", properties: { type: { type: "string" } } } },
  { name: "export_shape", inputSchema: { type: "object", properties: { shapeId: { type: "string" } } } },
  { name: "execute_code", inputSchema: { type: "object", properties: { code: { type: "string" } } } }
];

function fakeClient() {
  const calls = [];
  return {
    calls,
    async listTools() { return { tools }; },
    async callTool(input) {
      calls.push(input);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, tool: input.name }) }] };
    }
  };
}

test("Penpot endpoint normalization keeps credentials out of the public endpoint", () => {
  assert.equal(normalizePenpotEndpoint("http://localhost:9001/mcp/stream?userToken=secret"), "http://localhost:9001/mcp/stream");
  assert.throws(() => normalizePenpotEndpoint("ftp://localhost/mcp"), /http or https/);
  assert.equal(normalizePenpotEndpoint("https://penpot.example.com/mcp"), "https://penpot.example.com/mcp");
  const connection = new URL(penpotConnectionEndpoint("http://127.0.0.1:9001/mcp/stream", "test-token"));
  assert.equal(connection.origin + connection.pathname, "http://127.0.0.1:9001/mcp/stream");
  assert.equal(connection.searchParams.get("userToken"), "test-token");
});

test("Penpot classification is metadata and does not block trusted-local execution", () => {
  assert.equal(classifyPenpotTool(tools[0]), "read");
  assert.equal(classifyPenpotTool(tools[1]), "read");
  assert.equal(classifyPenpotTool(tools[2]), "read");
  assert.equal(classifyPenpotTool(tools[3], { code: "return penpot.currentPage" }), "mutation");
  assert.equal(classifyPenpotTool(tools[3], { code: "shape.remove()" }), "destructive");
  assert.equal(assertPenpotPolicy("execute_code", tools[3], { code: "shape.remove()" }, "mutation"), "destructive");
  assert.equal(assertPenpotPolicy("execute_code", tools[3], { code: "shape.remove()" }, "destructive", false), "destructive");
  assert.equal(assertPenpotPolicy("execute_code", tools[3], { code: "shape.remove()" }, "destructive", true), "destructive");
});

test("Penpot bridge forwards all live tools through trusted-local compatibility aliases", async () => {
  const client = fakeClient();
  await callReadOnlyPenpotTool("high_level_overview", {}, { client });
  await callMutatingPenpotTool("execute_code", { code: "return { ok: true }" }, { client });
  await callDestructivePenpotTool("execute_code", { code: "shape.remove()" }, { client });
  assert.deepEqual(client.calls.map((call) => call.name), ["high_level_overview", "execute_code", "execute_code"]);
  await callMutatingPenpotTool("execute_code", { code: "shape.delete()" }, { client });
  assert.equal(client.calls.length, 4);
});

test("Penpot inspection helpers execute bounded read templates", async () => {
  const client = fakeClient();
  await inspectPenpotPage({ client, maxDepth: 3, maxShapes: 25 });
  await inspectPenpotSelection({ client, maxDepth: 2, maxShapes: 10 });
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].name, "execute_code");
  assert.match(client.calls[0].arguments.code, /pageShapes/);
  assert.match(client.calls[0].arguments.code, /state\.count >= 25/);
  assert.match(client.calls[1].arguments.code, /const roots = selection/);
});

test("Penpot status and errors never reveal the user token", async () => {
  const client = fakeClient();
  const status = await penpotStatus({ client, endpoint: "http://127.0.0.1:9001/mcp/stream", userToken: "top-secret-token" });
  assert.equal(status.connected, true);
  assert.equal(status.tool_count, 4);
  assert.equal(status.auth_configured, true);
  assert.doesNotMatch(JSON.stringify(status), /top-secret-token/);
  assert.equal(redactPenpotSecrets("failed ?userToken=top-secret-token", ["top-secret-token"]), "failed ?userToken=[REDACTED]");
  assert.doesNotMatch(friendlyPenpotError(new Error("401 top-secret-token"), status.endpoint, "top-secret-token").message, /top-secret-token/);
});
