import test from "node:test";
import assert from "node:assert/strict";

import { TARGET_TOOL_CATALOG } from "./tool-catalog.js";
import {
  COMPACT_GROUP_DEFINITIONS,
  COMPACT_SERVER_INSTRUCTIONS,
  compactDefinitionContains,
  describeCompactActions,
  facadeNames,
  resolveCompactAction
} from "./compact-mcp-interface.js";

const backendTools = Object.values(COMPACT_GROUP_DEFINITIONS).flatMap((definition) => {
  const exact = definition.exact ? [...definition.exact] : [];
  const aliasTargets = Object.values(definition.aliases);
  const prefixed = definition.prefix ? [`${definition.prefix}future_tool`] : [];
  return [...new Set([...exact, ...aliasTargets, ...prefixed])].map((name) => ({
    name,
    description: `${name} description`,
    inputSchema: { required: ["path"], properties: { path: {}, limit: {} } }
  }));
});

test("facade registration order matches the target catalog", () => {
  const expected = TARGET_TOOL_CATALOG
    .map((tool) => tool.name)
    .filter((name) => name !== "workspace_context" && name !== "lca_input");
  assert.deepEqual(facadeNames(), expected);
});

test("every alias resolves to a tool allowed by its facade", () => {
  for (const facade of facadeNames()) {
    const definition = COMPACT_GROUP_DEFINITIONS[facade];
    for (const [alias, target] of Object.entries(definition.aliases)) {
      assert.equal(resolveCompactAction(facade, alias, backendTools), target);
      assert.equal(compactDefinitionContains(definition, target), true);
    }
  }
});


test("persistent task protocol actions are reachable through compact facades", () => {
  assert.equal(resolveCompactAction("workspace_read", "memory", backendTools), "memory_status");
  assert.equal(resolveCompactAction("workspace_read", "handoff", backendTools), "handoff_packet");
  assert.equal(resolveCompactAction("workspace_edit", "pin_context", backendTools), "context_pin");
  assert.equal(resolveCompactAction("workspace_edit", "scope", backendTools), "scope_guard");
  assert.equal(resolveCompactAction("workspace_exec", "parallel", backendTools), "parallel_tasks");
});

test("unknown and cross-facade actions are rejected", () => {
  assert.throws(
    () => resolveCompactAction("workspace_read", "run_command", backendTools),
    /Unknown workspace_read action/
  );
});

test("action discovery returns bounded schemas and aliases", () => {
  const discovered = describeCompactActions("workspace_read", backendTools);
  const readFile = discovered.actions.find((action) => action.name === "read_file");
  assert.equal(discovered.default_action, "read_many");
  assert.deepEqual(readFile?.aliases, ["one"]);
  assert.deepEqual(readFile?.required, ["path"]);
  assert.deepEqual(readFile?.input_keys, ["path", "limit"]);
});

test("compact instructions use the real discovery action", () => {
  assert.match(COMPACT_SERVER_INSTRUCTIONS, /action=discover/);
  assert.doesNotMatch(COMPACT_SERVER_INSTRUCTIONS, /action=actions only when you need discovery/);
});
