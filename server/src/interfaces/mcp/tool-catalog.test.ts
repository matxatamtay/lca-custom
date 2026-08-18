import test from "node:test";
import assert from "node:assert/strict";

import { TARGET_TOOL_CATALOG } from "./tool-catalog.js";

test("target MCP surface stays compact and uniquely named", () => {
  const names = TARGET_TOOL_CATALOG.map((tool) => tool.name);

  assert.ok(names.length <= 20, `expected at most 20 tools, received ${names.length}`);
  assert.equal(new Set(names).size, names.length, "tool names must be unique");
});

test("workspace_context explicitly requires CodeGraph and AgentMemory", () => {
  const tool = TARGET_TOOL_CATALOG.find((candidate) => candidate.name === "workspace_context");

  assert.ok(tool);
  assert.match(tool.description, /CodeGraph/);
  assert.match(tool.description, /AgentMemory/);
  assert.match(tool.description, /always/i);
});
