// Compact MCP surface regression tests
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { TARGET_TOOL_CATALOG } from "./dist/interfaces/mcp/tool-catalog.js";

const SERVER = path.resolve("server.mjs");
const FACADE_NAMES = [
  "workspace_search",
  "workspace_read",
  "workspace_edit",
  "workspace_exec",
  "workspace_process",
  "workspace_git",
  "workspace_verify",
  "workspace_status",
  "workspace_skill",
  "figma",
  "dbeaver",
  "bruno",
  "coolify"
];
const DIRECT_NAMES = new Set(["workspace_context", "lca_input", "notion_page"]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function startServer(workspace) {
  const port = await getFreePort();
  const stderrRef = { value: "" };
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_WORKSPACE: workspace,
      AGENT_EXTRA_ROOTS_JSON: "[]",
      AGENTMEMORY_RECORD_SESSIONS: "0",
      MCP_AUTH_TOKEN: "",
      AGENT_AUDIT: "0"
    },
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.on("data", (chunk) => (stderrRef.value += chunk));

  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return { child, port };
    } catch {}
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}\n${stderrRef.value}`);
    await wait(100);
  }
  throw new Error(`Server did not become ready on port ${port}\n${stderrRef.value}`);
}

async function stopServer(server) {
  if (!server?.child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(server.child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    server.child.kill("SIGTERM");
  }
  await wait(300);
}

async function connect(port) {
  const client = new Client({ name: "compact-surface-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

function firstText(result) {
  return result?.content?.find((item) => item.type === "text")?.text || "";
}

function parseJsonResult(result) {
  return JSON.parse(firstText(result));
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "lca-compact-surface-"));
let server;
let client;

try {
  server = await startServer(workspace);
  client = await connect(server.port);

  const compactTools = (await client.listTools()).tools || [];
  const compactNames = compactTools.map((tool) => tool.name);
  const targetNames = TARGET_TOOL_CATALOG.map((tool) => tool.name);

  assert.deepEqual(compactNames, targetNames, "active compact surface must match the target catalog exactly");
  assert.equal(compactNames.includes("workspace_agent"), false, "delegated model-agent facade must stay removed");
  assert.ok(compactTools.length <= 20, `expected at most 20 tools, received ${compactTools.length}`);

  const schemaBytes = Buffer.byteLength(JSON.stringify(compactTools), "utf8");
  assert.ok(schemaBytes <= 24_000, `compact tool schema is too large: ${schemaBytes} bytes`);

  const assigned = new Map();
  for (const facade of FACADE_NAMES) {
    const discovered = await client.callTool({ name: facade, arguments: { action: "discover" } });
    assert.equal(discovered.isError, undefined, `${facade} discovery failed: ${firstText(discovered)}`);
    for (const action of discovered.structuredContent?.actions || []) {
      const groups = assigned.get(action.name) || [];
      groups.push(facade);
      assigned.set(action.name, groups);
    }
  }

  const duplicated = [...assigned.entries()].filter(([, groups]) => groups.length !== 1);
  assert.deepEqual(duplicated, [], `hidden tools assigned to multiple facades: ${JSON.stringify(duplicated)}`);
  assert.equal(assigned.size, 176, `expected complete merged internal backend coverage, received ${assigned.size} actions`);
  for (const action of ["worktree_create", "worktree_status", "worktree_diff", "worktree_check", "worktree_gc", "worktree_cleanup"]) {
    assert.deepEqual(assigned.get(action), ["workspace_git"], `${action} must stay behind workspace_git`);
  }
  assert.deepEqual(assigned.get("verify_changed"), ["workspace_verify"], "verify_changed must stay behind workspace_verify");
  assert.deepEqual(assigned.get("semgrep_scan"), ["workspace_verify"], "Semgrep scan must stay behind workspace_verify");
  assert.deepEqual(assigned.get("semgrep_rules"), ["workspace_verify"], "learned Semgrep rule lifecycle must stay behind workspace_verify");
  assert.deepEqual(assigned.get("mutation_test"), ["workspace_verify"], "mutation testing must stay behind workspace_verify");
  assert.deepEqual(assigned.get("performance_follow"), ["workspace_status"], "performance_follow must stay behind workspace_status");
  assert.deepEqual(assigned.get("improvement_candidates"), ["workspace_status"], "improvement candidates must stay behind workspace_status");
  assert.deepEqual(assigned.get("dependency_feed"), ["workspace_status"], "dependency feed must stay behind workspace_status");
  assert.deepEqual(assigned.get("tool_trace"), ["workspace_status"], "runtime trace must stay behind workspace_status");
  assert.deepEqual(assigned.get("ast_search"), ["workspace_search"], "ast structural search must stay behind workspace_search");
  assert.deepEqual(assigned.get("ast_rewrite"), ["workspace_edit"], "ast structural rewrite must stay behind workspace_edit");
  for (const directName of DIRECT_NAMES) assert.ok(compactNames.includes(directName), `${directName} must remain direct`);

  const writeResult = await client.callTool({
    name: "workspace_edit",
    arguments: { action: "write", arguments: { path: "compact.txt", content: "compact facade works\n" } }
  });
  assert.notEqual(writeResult.isError, true, firstText(writeResult));

  const readResult = await client.callTool({
    name: "workspace_read",
    arguments: { action: "one", arguments: { path: "compact.txt" } }
  });
  assert.equal(parseJsonResult(readResult).content, "compact facade works\n");

  const astFixture = await client.callTool({
    name: "workspace_edit",
    arguments: { action: "write", arguments: { path: "ast-sample.ts", content: "const structural = Promise.all([one, two]);\n" } }
  });
  assert.notEqual(astFixture.isError, true, firstText(astFixture));
  const astResult = parseJsonResult(await client.callTool({
    name: "workspace_search",
    arguments: {
      action: "ast",
      arguments: { pattern: "Promise.all($$$A)", lang: "ts", path: "ast-sample.ts", limit: 5 }
    }
  }));
  assert.equal(astResult.engine, "ast-grep");
  if (astResult.available) {
    assert.equal(astResult.ok, true, JSON.stringify(astResult));
    assert.equal(astResult.count, 1);
    assert.equal(astResult.matches[0].path, "ast-sample.ts");
    assert.equal(astResult.matches[0].node_kind, "call_expression");
    assert.ok(astResult.matches[0].captures.A);
  } else {
    assert.match(astResult.reason || "", /unavailable/i);
    assert.deepEqual(astResult.matches, []);
  }
  const textSearchResult = parseJsonResult(await client.callTool({
    name: "workspace_search",
    arguments: {
      action: "text",
      arguments: { query: "Promise.all", path: "ast-sample.ts", limit: 5 }
    }
  }));
  assert.equal(textSearchResult.count, 1);

  if (astResult.available) {
    const dryRewrite = parseJsonResult(await client.callTool({
      name: "workspace_edit",
      arguments: {
        action: "ast_rewrite",
        arguments: {
          pattern: "const $A = $B",
          rewrite: "let $A = $B",
          lang: "ts",
          paths: ["ast-sample.ts"],
          max_matches: 2,
          dry_run: true,
          verify: "changed"
        }
      }
    }));
    assert.equal(dryRewrite.ok, true, JSON.stringify(dryRewrite));
    assert.equal(dryRewrite.dry_run, true);
    assert.equal(dryRewrite.applied, false);
    assert.equal(dryRewrite.count, 1);
    const afterDryRun = parseJsonResult(await client.callTool({
      name: "workspace_read",
      arguments: { action: "one", arguments: { path: "ast-sample.ts" } }
    }));
    assert.match(afterDryRun.content, /^const structural/);

    const appliedRewrite = parseJsonResult(await client.callTool({
      name: "workspace_edit",
      arguments: {
        action: "ast_rewrite",
        arguments: {
          pattern: "const $A = $B",
          rewrite: "let $A = $B",
          lang: "ts",
          paths: ["ast-sample.ts"],
          max_matches: 2,
          dry_run: false,
          verify: "changed"
        }
      }
    }));
    assert.equal(appliedRewrite.ok, true, JSON.stringify(appliedRewrite));
    assert.equal(appliedRewrite.applied, true);
    assert.equal(appliedRewrite.regression_gate, "pass");
    assert.equal(appliedRewrite.rollback_available, true);
    assert.equal(appliedRewrite.verification?.requested, true);
    assert.ok(appliedRewrite.post_edit?.roots?.[0]?.semantic, "ast rewrite must run post-edit semantic diagnostics");
    const afterRewrite = parseJsonResult(await client.callTool({
      name: "workspace_read",
      arguments: { action: "one", arguments: { path: "ast-sample.ts" } }
    }));
    assert.match(afterRewrite.content, /^let structural/);

    const undoRewrite = parseJsonResult(await client.callTool({
      name: "workspace_edit",
      arguments: { action: "undo", arguments: {} }
    }));
    assert.equal(undoRewrite.ok, true, JSON.stringify(undoRewrite));
    assert.equal(undoRewrite.tool, "ast_rewrite");
    const afterUndo = parseJsonResult(await client.callTool({
      name: "workspace_read",
      arguments: { action: "one", arguments: { path: "ast-sample.ts" } }
    }));
    assert.match(afterUndo.content, /^const structural/);
  }

  const fusedPatchResult = await client.callTool({
    name: "workspace_edit",
    arguments: {
      action: "apply_patch",
      arguments: {
        operations: [{
          op: "update",
          path: "compact.txt",
          edits: [{ old_text: "compact facade works", new_text: "compact facade works faster" }]
        }],
        verify: "changed"
      }
    }
  });
  assert.notEqual(fusedPatchResult.isError, true, `fused apply_patch verification failed: ${firstText(fusedPatchResult)}`);
  const fusedPatch = parseJsonResult(fusedPatchResult);
  assert.equal(fusedPatch.ok, true);
  assert.equal(fusedPatch.verification?.requested, true);
  assert.equal(fusedPatch.verification?.ok, true);
  assert.ok(Number(fusedPatch.verification?.duration_ms) >= 0);

  const runtimeTrace = parseJsonResult(await client.callTool({
    name: "workspace_status",
    arguments: {
      action: "trace",
      arguments: { trace_limit: 10, span_limit: 500 }
    }
  }));
  assert.equal(runtimeTrace.kind, "runtime_trace_waterfall");
  assert.equal(runtimeTrace.source, "RuntimeEventStore");
  assert.equal(runtimeTrace.authoritative_history, "performance_follow");
  assert.equal(typeof runtimeTrace.otel_export_enabled, "boolean");
  const traceSpans = runtimeTrace.groups.flatMap((group) => group.spans || []);
  for (const name of [
    "workspace_edit.match",
    "workspace_edit.write",
    "workspace_edit.semantic_refresh",
    "workspace_edit.verify_changed"
  ]) {
    assert.ok(traceSpans.some((span) => span.name === name), `missing runtime trace span ${name}`);
  }
  assert.ok(traceSpans.some((span) => span.name === "workspace_edit.verify_changed" && span.depth >= 1));

  const draftRule = parseJsonResult(await client.callTool({
    name: "workspace_verify",
    arguments: {
      action: "regression_rules",
      arguments: {
        cwd: workspace,
        operation: "draft",
        id: "compact-runtime",
        message: "Prevent BAD_RULE marker",
        lang: "generic",
        pattern_regex: "BAD_RULE\\(",
        severity: "ERROR",
        category: "CORRECTNESS",
        component: "compact-runtime",
        before: "BAD_RULE();",
        after: "GOOD_RULE();"
      }
    }
  }));
  assert.equal(draftRule.ok, true, JSON.stringify(draftRule));
  assert.equal(draftRule.rule.state, "draft");

  const shadowRule = parseJsonResult(await client.callTool({
    name: "workspace_verify",
    arguments: {
      action: "semgrep_rules",
      arguments: { cwd: workspace, operation: "promote", id: draftRule.rule.id, to: "shadow" }
    }
  }));
  assert.equal(shadowRule.ok, true, JSON.stringify(shadowRule));
  assert.equal(shadowRule.rule.state, "shadow");

  const fixtureRule = parseJsonResult(await client.callTool({
    name: "workspace_verify",
    arguments: {
      action: "semgrep_rules",
      arguments: { cwd: workspace, operation: "validate_fixture", id: draftRule.rule.id }
    }
  }));
  assert.equal(fixtureRule.ok, true, JSON.stringify(fixtureRule));
  assert.equal(fixtureRule.rule.validation.fixture_passed, true);

  const validatedRule = parseJsonResult(await client.callTool({
    name: "workspace_verify",
    arguments: {
      action: "semgrep_rules",
      arguments: { cwd: workspace, operation: "promote", id: draftRule.rule.id, to: "validated" }
    }
  }));
  assert.equal(validatedRule.ok, true, JSON.stringify(validatedRule));
  assert.equal(validatedRule.rule.state, "validated");

  const blockedRule = parseJsonResult(await client.callTool({
    name: "workspace_verify",
    arguments: {
      action: "semgrep_rules",
      arguments: { cwd: workspace, operation: "promote", id: draftRule.rule.id, to: "blocking" }
    }
  }));
  assert.equal(blockedRule.ok, false, JSON.stringify(blockedRule));
  assert.equal(blockedRule.blocked, true);
  assert.equal(blockedRule.requirements.min_runs, 5);
  assert.equal(blockedRule.requirements.runs, 0);

  const semgrepResult = parseJsonResult(await client.callTool({
    name: "workspace_verify",
    arguments: { action: "semgrep", arguments: { cwd: workspace, max_results: 20 } }
  }));
  assert.equal(semgrepResult.engine, "semgrep");
  if (semgrepResult.available) {
    assert.ok(["pass", "fail"].includes(semgrepResult.gate));
    assert.ok(semgrepResult.summary);
    assert.ok(Array.isArray(semgrepResult.findings));
  } else {
    assert.equal(semgrepResult.gate, "unavailable");
    assert.match(semgrepResult.reason || "", /semgrep/i);
  }

  const mutationResult = parseJsonResult(await client.callTool({
    name: "workspace_verify",
    arguments: {
      action: "mutation",
      arguments: { cwd: workspace, mode: "changed", max_candidates: 20 }
    }
  }));
  assert.equal(mutationResult.engine, "stryker");
  if (mutationResult.available) {
    assert.ok(["pass", "warn", "fail"].includes(mutationResult.gate));
    assert.ok(mutationResult.telemetry);
    assert.ok(Array.isArray(mutationResult.surviving_mutants));
  } else {
    assert.equal(mutationResult.gate, "unavailable");
    assert.match(mutationResult.reason || "", /stryker/i);
  }

  const changedPlanResult = await client.callTool({
    name: "workspace_verify",
    arguments: { action: "verify_changed", arguments: { cwd: workspace, changed_files: ["compact.txt"], execute: false, fresh: true } }
  });
  assert.notEqual(changedPlanResult.isError, true, `verify_changed runtime binding failed: ${firstText(changedPlanResult)}`);
  const changedPlan = parseJsonResult(changedPlanResult);
  assert.equal(changedPlan.root, workspace);
  assert.deepEqual(changedPlan.changed_files, ["compact.txt"]);

  const blocked = await client.callTool({
    name: "workspace_read",
    arguments: { action: "run_command", arguments: { command: "echo should-not-run" } }
  });
  assert.equal(blocked.isError, true, "cross-group backend dispatch must be rejected");
  assert.match(firstText(blocked), /Unknown workspace_read action/);

  const status = parseJsonResult(await client.callTool({ name: "workspace_status", arguments: {} }));
  assert.equal(status.tool_surface, "compact");
  assert.ok(status.runtime_recovery, "workspace_info must surface runtime recovery metrics");
  assert.ok(status.runtime_recovery.transactions, "workspace_info recovery metrics must include transactions");
  assert.ok(status.performance, "workspace_info must surface performance telemetry");
  assert.equal(status.performance.version, 2);
  assert.ok(status.performance.aggregate, "performance telemetry must include aggregate task metrics");
  assert.ok(status.performance_follow, "workspace_info must surface performance follow rollups");
  assert.equal(status.performance_follow.version, 1);

  const performance = parseJsonResult(await client.callTool({
    name: "workspace_status",
    arguments: { action: "performance", arguments: { path: workspace, window_days: 30, task_class: "all", compact: true } }
  }));
  assert.equal(performance.version, 1);
  assert.equal(performance.query.root, workspace);
  assert.ok(Array.isArray(performance.bottlenecks));
  assert.equal(performance.search_efficiency.by_action.text.calls >= 1, true);
  if (astResult.available) assert.equal(performance.search_efficiency.by_action.ast.calls >= 1, true);
  assert.equal(performance.semgrep.samples >= 1, true);
  if (!semgrepResult.available) assert.equal(performance.semgrep.unavailable_samples >= 1, true);
  assert.equal(performance.mutation.samples >= 1, true);
  if (!mutationResult.available) assert.equal(performance.mutation.unavailable_samples >= 1, true);

  const improvements = parseJsonResult(await client.callTool({
    name: "workspace_status",
    arguments: { action: "improvements", arguments: { path: workspace, window_days: 30, task_class: "all", limit: 5 } }
  }));
  assert.equal(improvements.version, 1);
  assert.equal(improvements.root, workspace);
  assert.ok(improvements.baseline?.id);
  assert.ok(Array.isArray(improvements.candidates));

  const dependencyFeed = parseJsonResult(await client.callTool({
    name: "workspace_status",
    arguments: {
      action: "dependencies",
      arguments: { path: workspace, ingest: true }
    }
  }));
  assert.equal(dependencyFeed.engine, "renovate");
  assert.equal(dependencyFeed.analysis_only, true);
  assert.equal(dependencyFeed.auto_apply, false);
  assert.equal(dependencyFeed.auto_merge, false);
  assert.equal(dependencyFeed.binary?.executed, false);
  assert.ok(Array.isArray(dependencyFeed.candidates));
  if (!dependencyFeed.available) {
    assert.equal(dependencyFeed.reason, "renovate_feed_report_unavailable");
  }

  const doctor = parseJsonResult(await client.callTool({
    name: "workspace_status",
    arguments: { action: "doctor", arguments: {} }
  }));
  assert.ok(doctor.runtime_recovery, "workspace_doctor must surface runtime recovery metrics");

  const lcaInput = compactTools.find((tool) => tool.name === "lca_input");
  assert.match(lcaInput?._meta?.["openai/outputTemplate"] || "", /^ui:\/\/widget\/lca-compact-input-v2-[a-f0-9]{12}\.html$/);
  const notionPage = compactTools.find((tool) => tool.name === "notion_page");
  assert.equal(notionPage?.annotations?.readOnlyHint, true, "notion_page proposal staging must remain read-only");
  assert.ok(notionPage?.inputSchema?.properties?.proposal_scope, "notion_page must expose staged proposal scope");
  assert.ok(notionPage?.inputSchema?.properties?.proposal_replacement, "notion_page must accept selected-content proposal replacements");
  assert.ok(notionPage?.inputSchema?.properties?.proposal_markdown, "notion_page must accept whole-page proposal markdown");
  const notionTemplateUri = notionPage?._meta?.["openai/outputTemplate"] || "";
  assert.match(notionTemplateUri, /^ui:\/\/widget\/lca-notion-page-[a-f0-9]{12}-mcp-app-v1\.html$/);
  const notionResource = await client.readResource({ uri: notionTemplateUri });
  assert.equal(notionResource.contents?.[0]?.mimeType, "text/html;profile=mcp-app", "Notion widget must use the MCP Apps HTML MIME type");
  assert.deepEqual(
    notionResource.contents?.[0]?._meta?.["openai/widgetCSP"]?.redirect_domains,
    ["https://app.notion.com"],
    "Notion widget must allow its external Notion page origin"
  );
  assert.deepEqual(
    notionResource.contents?.[0]?._meta?.ui?.csp?.resourceDomains,
    [
      "https://s3-us-west-2.amazonaws.com",
      "https://prod-files-secure.s3.us-west-2.amazonaws.com",
      "https://file.notion.so",
      "https://www.notion.so"
    ],
    "Notion widget must allow only its known media/static origins"
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    model_facing_tools: compactTools.length,
    internal_backend_actions: assigned.size,
    compact_schema_bytes: schemaBytes,
    hidden_actions_covered: assigned.size
  }, null, 2)}\n`);
} finally {
  try { await client?.close(); } catch {}
  await stopServer(server);
  await rm(workspace, { recursive: true, force: true });
}
