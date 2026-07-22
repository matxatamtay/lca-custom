// Local Coding Agent TUI — compact MCP client
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PersistentHttpMcpClient } from "../persistent-http-mcp-client.mjs";
import { compactFacadeCall, dataFromToolResult } from "./model.mjs";

export class LcaTuiClient {
  constructor(options = {}) {
    this.endpoint = String(options.endpoint || "http://127.0.0.1:8790/mcp");
    this.healthUrl = String(options.healthUrl || this.endpoint.replace(/\/mcp\/?$/, "/healthz"));
    this.memoryUrl = String(options.memoryUrl || "http://127.0.0.1:3111").replace(/\/$/, "");
    const authToken = String(options.authToken || "").trim();
    this.client = options.client || new PersistentHttpMcpClient({
      endpoint: this.endpoint,
      clientName: "local-coding-agent-tui",
      clientVersion: options.version || "4.4.0-pro",
      timeoutMs: options.timeoutMs || 120_000,
      ...(authToken ? { requestInit: { headers: { Authorization: `Bearer ${authToken}` } } } : {})
    });
  }

  listTools(options) {
    return this.client.listTools(options);
  }

  callTool(name, args = {}) {
    return this.client.callTool({ name, arguments: args });
  }

  callFacade(facade, action, args = {}) {
    return this.client.callTool(compactFacadeCall(facade, action, args));
  }

  async data(facade, action, args = {}) {
    const result = await this.callFacade(facade, action, args);
    if (result?.isError) throw new Error(extractError(result));
    return dataFromToolResult(result);
  }

  async health() {
    const response = await fetch(this.healthUrl, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`LCA health returned HTTP ${response.status}`);
    return response.json();
  }

  async memoryHealth() {
    for (const suffix of ["/agentmemory/health", "/agentmemory/livez"]) {
      try {
        const response = await fetch(`${this.memoryUrl}${suffix}`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) return response.json();
      } catch {
        // Try the lightweight fallback route.
      }
    }
    return { status: "offline" };
  }

  info() { return this.data("workspace_status", "info"); }
  doctor(path) { return this.data("workspace_status", "doctor", path ? { path } : {}); }
  snapshot(path) { return this.data("workspace_status", "snapshot", path ? { path, depth: 3, max_entries: 300 } : { depth: 3, max_entries: 300 }); }
  listFiles(path, options = {}) { return this.data("workspace_read", "list", { path, recursive: options.recursive === true, limit: options.limit || 500 }); }
  readFile(path, options = {}) { return this.data("workspace_read", "one", { path, max_chars: options.maxChars || 200_000, ...(options.startLine ? { start_line: options.startLine } : {}), ...(options.lineCount ? { line_count: options.lineCount } : {}) }); }
  search(query, path, options = {}) { return this.data("workspace_search", "text", { query, path, regex: options.regex === true, context: options.context ?? 2, limit: options.limit ?? 200, ...(options.glob ? { glob: options.glob } : {}) }); }
  context(task, path, options = {}) {
    return this.data("workspace_context", null, {
      task,
      path,
      intent: options.intent || "understand",
      max_items: options.maxItems || 24,
      max_chars: options.maxChars || 60_000
    });
  }
  gitStatus(cwd) { return this.data("workspace_git", "status", { cwd }); }
  gitDiff(cwd, staged = false) { return this.data("workspace_git", "diff", { cwd, staged }); }
  git(args, cwd) { return this.data("workspace_git", "run", { args, cwd }); }
  command(command, cwd, options = {}) { return this.data("workspace_exec", "one", { command, cwd, timeout_ms: options.timeoutMs || 120_000, max_output_chars: options.maxOutputChars || 200_000 }); }
  processes() { return this.data("workspace_process", "list"); }
  processStart(command, cwd, name) { return this.data("workspace_process", "start", { command, cwd, ...(name ? { name } : {}) }); }
  processOutput(id) { return this.data("workspace_process", "output", { id }); }
  processStop(id) { return this.data("workspace_process", "stop", { id }); }
  verify(action, cwd, options = {}) {
    const location = action === "detect" ? { path: cwd } : { cwd };
    return this.data("workspace_verify", action, { ...location, ...options });
  }
  taskState(args = {}) { return this.data("workspace_edit", "state", args); }
  taskPlan(goal, steps) { return this.data("workspace_edit", "plan", { goal, steps }); }
  note(title, body) { return this.data("workspace_edit", "note", { title, body }); }
  checkpoint(summary, nextSteps = []) { return this.data("workspace_edit", "checkpoint", { summary, next_steps: nextSteps }); }
  undo() { return this.data("workspace_edit", "undo"); }
  skills() { return this.data("workspace_skill", "list"); }
  readSkill(name) { return this.data("workspace_skill", "read", { name }); }
  createSkill(name, description, body) { return this.data("workspace_skill", "create", { name, description, body }); }
  deleteSkill(name) { return this.data("workspace_skill", "delete", { name }); }
  integration(name, action = "status", args = {}) { return this.data(name, action, args); }
  discover(facade) { return this.data(facade, "discover"); }

  close() {
    return this.client.close();
  }
}

function extractError(result) {
  const text = (result?.content ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  return text || "LCA tool call failed.";
}
