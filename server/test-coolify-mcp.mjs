import test from "node:test";
import assert from "node:assert/strict";

import {
  callCoolifyMcpTool,
  closeCoolifyMcpClients,
  coolifyMcpStatus,
  friendlyCoolifyMcpError,
  normalizeCoolifyMcpEndpoint
} from "./coolify-mcp.mjs";

test.afterEach(async () => {
  await closeCoolifyMcpClients();
});

test("normalizes Coolify MCP endpoints", () => {
  assert.equal(normalizeCoolifyMcpEndpoint("http://example.test"), "http://example.test/mcp");
  assert.equal(normalizeCoolifyMcpEndpoint("https://example.test/custom"), "https://example.test/custom");
  assert.throws(() => normalizeCoolifyMcpEndpoint("file:///tmp/mcp"), /http or https/);
});

test("maps authentication errors without exposing credentials", () => {
  const error = friendlyCoolifyMcpError(new Error("HTTP 401 Unauthorized"), "http://example.test/mcp");
  assert.match(error.message, /COOLIFY_MCP_AUTH_TOKEN/);
  assert.doesNotMatch(error.message, /super-secret-token/);
});

test("status reports missing authentication without throwing", async () => {
  const status = await coolifyMcpStatus({
    endpoint: "http://127.0.0.1:1/mcp",
    authToken: "",
    timeoutMs: 1_000
  });
  assert.equal(status.connected, false);
  assert.equal(status.auth_configured, false);
  assert.equal(status.tool_count, 0);
});

test("rejects empty tool names before connecting", async () => {
  await assert.rejects(callCoolifyMcpTool("", {}, { endpoint: "http://127.0.0.1:1/mcp" }), /tool name is required/);
});
