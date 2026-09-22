import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { TARGET_TOOL_CATALOG } from "./dist/interfaces/mcp/tool-catalog.js";
import {
  COMPACT_GROUP_DEFINITIONS,
  facadeNames
} from "./dist/interfaces/mcp/compact-mcp-interface.js";

const SERVER_ROOT = path.resolve(".");
const REPO_ROOT = path.resolve("..");

test("final self-improvement architecture remains direct-only with 19 public tools", async () => {
  assert.equal(TARGET_TOOL_CATALOG.length, 19);
  assert.equal(
    facadeNames().length,
    16,
    "workspace_context, lca_input, and notion_page are registered outside facadeNames()"
  );
  assert.equal(TARGET_TOOL_CATALOG.some((tool) => tool.name === "workspace_agent"), false);

  const packageJson = JSON.parse(await readFile(path.join(SERVER_ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.dependencies?.["@openai/codex-sdk"], undefined);
  assert.equal(packageJson.devDependencies?.["@openai/codex-sdk"], undefined);

  const serverSource = await readFile(path.join(SERVER_ROOT, "server.mjs"), "utf8");
  assert.doesNotMatch(serverSource, /\bCodexDelegationManager\b/);
  assert.doesNotMatch(serverSource, /\bAgentRunnerRegistry\b/);
  assert.doesNotMatch(serverSource, /\bworkspace_agent\b/);

  for (const file of [
    "agent-provider-config.mjs",
    "agent-runner.mjs",
    "agent-runner-codex.mjs",
    "agent-runner-gemini.mjs"
  ]) {
    await assert.rejects(
      () => access(path.join(SERVER_ROOT, file)),
      /ENOENT/,
      file + " must stay removed"
    );
  }
});

test("optional self-improvement sensors never become mandatory workspace_context providers", async () => {
  const source = await readFile(
    path.join(SERVER_ROOT, "src", "application", "context", "build-task-context.ts"),
    "utf8"
  );

  for (const provider of ["filesystem", "semantic", "codegraph", "agentmemory"]) {
    assert.match(source, new RegExp("\\b" + provider + "\\b"), provider + " must remain in workspace_context");
  }
  for (const forbidden of [
    "semgrep",
    "stryker",
    "renovate",
    "ast-grep",
    "astGrep"
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(forbidden, "i"),
      forbidden + " must remain on-demand rather than mandatory context fan-out"
    );
  }
});

test("self-improvement features remain behind existing compact facades", () => {
  const status = COMPACT_GROUP_DEFINITIONS.workspace_status;
  const verify = COMPACT_GROUP_DEFINITIONS.workspace_verify;
  const search = COMPACT_GROUP_DEFINITIONS.workspace_search;
  const edit = COMPACT_GROUP_DEFINITIONS.workspace_edit;

  for (const action of [
    "performance_follow",
    "improvement_candidates",
    "dependency_feed",
    "tool_trace"
  ]) {
    assert.equal(status.exact?.has(action), true, action + " must stay behind workspace_status");
  }
  assert.equal(search.exact?.has("ast_search"), true);
  assert.equal(edit.exact?.has("ast_rewrite"), true);
  assert.equal(verify.exact?.has("semgrep_scan"), true);
  assert.equal(verify.exact?.has("mutation_test"), true);
});

test("improvement CLI has no automatic git, exec, or secondary-model execution path", async () => {
  const improveSource = await readFile(
    path.join(REPO_ROOT, "scripts", "lib", "improve-command.mjs"),
    "utf8"
  );
  const maintenanceSource = await readFile(
    path.join(REPO_ROOT, "scripts", "lib", "maintenance-command.mjs"),
    "utf8"
  );
  const combined = improveSource + "\n" + maintenanceSource;

  assert.doesNotMatch(combined, /workspace_git/);
  assert.doesNotMatch(combined, /workspace_exec/);
  assert.doesNotMatch(improveSource, /CodexDelegationManager|AgentRunnerRegistry|Hermes/i);
  assert.doesNotMatch(maintenanceSource, /from\s+["'][^"']*(?:codex|agent-runner|hermes)|workspace_agent/i);
  assert.match(maintenanceSource, /CodexDelegationManager/);
  assert.match(maintenanceSource, /AgentRunnerRegistry/);
  assert.match(improveSource, /commit_performed:\s*false/);
  assert.match(improveSource, /push_performed:\s*false/);
  assert.match(maintenanceSource, /analysis_only:\s*true/);
  assert.match(maintenanceSource, /architectural_redesign_forbidden/);
});
