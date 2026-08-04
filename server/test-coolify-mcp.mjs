import test from "node:test";
import assert from "node:assert/strict";

import {
  callCoolifyMcpTool,
  callDestructiveCoolifyMcpTool,
  callMutatingCoolifyMcpTool,
  callReadOnlyCoolifyMcpTool,
  classifyCoolifyTool,
  closeCoolifyMcpClients,
  coolifyMcpStatus,
  friendlyCoolifyMcpError,
  listCoolifyMcpTools,
  normalizeCoolifyBaseUrl,
  resolveCoolifyMcpEntry
} from "./coolify-mcp.mjs";

const testOptions = {
  baseUrl: "https://coolify.example.test",
  accessToken: "test-token-not-a-secret",
  timeoutMs: 15_000
};

test.afterEach(async () => {
  await closeCoolifyMcpClients();
});

test("normalizes Coolify instance URLs", () => {
  assert.equal(normalizeCoolifyBaseUrl("https://example.test/"), "https://example.test");
  assert.equal(normalizeCoolifyBaseUrl("http://example.test/coolify/"), "http://example.test/coolify");
  assert.throws(() => normalizeCoolifyBaseUrl(""), /COOLIFY_BASE_URL is required/);
  assert.throws(() => normalizeCoolifyBaseUrl("file:///tmp/coolify"), /http or https/);
});

test("resolves the pinned local Coolify MCP package", () => {
  const entry = resolveCoolifyMcpEntry();
  assert.match(entry, /@masonator[\\/]coolify-mcp[\\/]dist[\\/]index\.js$/);
});

test("maps authentication errors without exposing credentials", () => {
  const error = friendlyCoolifyMcpError(
    new Error("HTTP 401 Unauthorized token=test-token-not-a-secret"),
    "https://example.test"
  );
  assert.match(error.message, /COOLIFY_ACCESS_TOKEN/);
  assert.doesNotMatch(error.message, /test-token-not-a-secret/);
});

test("status reports missing configuration without throwing", async () => {
  const status = await coolifyMcpStatus({ baseUrl: "", accessToken: "" });
  assert.equal(status.connected, false);
  assert.equal(status.transport, "stdio");
  assert.equal(status.auth_configured, false);
  assert.equal(status.tool_count, 0);
});

test("starts the pinned MCP package over stdio and discovers its live tools", async () => {
  const listed = await listCoolifyMcpTools(testOptions);
  const names = listed.tools.map((tool) => tool.name);
  assert.ok(names.length >= 40, `expected at least 40 tools, got ${names.length}`);
  assert.ok(names.includes("get_infrastructure_overview"));
  assert.ok(names.includes("deploy"));
  assert.ok(names.includes("application"));
});

test("classifies read, mutation, and destructive actions", () => {
  assert.equal(classifyCoolifyTool({ name: "list_servers", annotations: { readOnlyHint: true } }), "read");
  assert.equal(classifyCoolifyTool({ name: "application", annotations: { destructiveHint: true } }, { action: "update" }), "mutation");
  assert.equal(classifyCoolifyTool({ name: "application", annotations: { destructiveHint: true } }, { action: "delete" }), "destructive");
  assert.equal(classifyCoolifyTool({ name: "database_backups", annotations: { destructiveHint: true } }, { action: "delete_execution" }), "destructive");
  assert.equal(classifyCoolifyTool({ name: "database_backups", annotations: { destructiveHint: true } }, { action: "list_schedules" }), "read");
  assert.equal(classifyCoolifyTool({ name: "application", annotations: { destructiveHint: true } }, { action: "delete_preview" }), "destructive");
  assert.equal(classifyCoolifyTool({ name: "stop_all_apps", annotations: { destructiveHint: true } }), "destructive");
  assert.equal(
    classifyCoolifyTool({
      name: "projects",
      annotations: { destructiveHint: true },
      inputSchema: { properties: { action: { enum: ["list", "create", "delete"] } } }
    }),
    "mixed"
  );
});

test("rejects empty tool names before making an upstream API call", async () => {
  await assert.rejects(callCoolifyMcpTool("", {}, testOptions), /tool name is required/);
});

test("read policy rejects mutations before making an upstream API call", async () => {
  await assert.rejects(
    callReadOnlyCoolifyMcpTool("deploy", { uuid: "fake" }, testOptions),
    /is mutation/
  );
});

test("mutation policy rejects reads before making an upstream API call", async () => {
  await assert.rejects(
    callMutatingCoolifyMcpTool("list_servers", {}, testOptions),
    /is read/
  );
});

test("compatibility calls reject destructive actions", async () => {
  await assert.rejects(
    callCoolifyMcpTool("application", { action: "delete", uuid: "fake" }, testOptions),
    /destructive/
  );
});

test("destructive policy requires explicit confirmation", async () => {
  await assert.rejects(
    callDestructiveCoolifyMcpTool(
      "application",
      { action: "delete", uuid: "fake" },
      testOptions
    ),
    /confirmed=true/
  );
});
