// Test helper for exercising hidden backend actions through the compact facade.
// SPDX-License-Identifier: AGPL-3.0-or-later

const DIRECT = new Set(["workspace_context", "lca_input"]);

const GROUPS = [
  ["workspace_search", new Set(["workspace_search", "search_text", "find_files", "repo_symbols", "repo_map", "repo_overview", "important_files", "index_status", "todo_scan"])],
  ["workspace_read", new Set(["read_file", "read_many", "stat_path", "list_files", "list_notes", "resume"])],
  ["workspace_edit", new Set(["apply_patch", "preview_patch", "validate_patch", "undo_last_patch", "write_file", "replace_in_file", "make_dir", "move_path", "delete_path", "save_note", "checkpoint", "decision_log", "task_plan", "task_state"])],
  ["workspace_exec", new Set(["run_command", "run_commands"])],
  ["workspace_process", (name) => name.startsWith("proc_")],
  ["workspace_git", new Set(["git", "git_status", "git_diff"])],
  ["workspace_verify", new Set(["detect_test_commands", "quality_gate", "run_tests", "run_changed_tests", "run_build", "run_lint", "review_diff", "security_scan", "change_summary", "session_report"])],
  ["workspace_status", new Set(["ping", "workspace_info", "lca", "workspace_doctor", "workspace_snapshot", "project_profile", "profile_status", "reload_profile"])],
  ["workspace_skill", new Set(["list_skills", "read_skill", "create_skill", "delete_skill", "slash_commands", "compose_prompt"])],
  ["figma", (name) => name.startsWith("figma_")],
  ["dbeaver", (name) => name.startsWith("dbeaver_")],
  ["bruno", (name) => name.startsWith("bruno_")]
];

export function compactFacadeFor(name) {
  if (DIRECT.has(name)) return null;
  for (const [facade, matcher] of GROUPS) {
    if (matcher instanceof Set ? matcher.has(name) : matcher(name)) return facade;
  }
  throw new Error(`No compact facade route for backend tool ${name}`);
}

export function compactCallInput(name, args = {}) {
  if (DIRECT.has(name)) return { name, arguments: args };
  return {
    name: compactFacadeFor(name),
    arguments: { action: name, arguments: args }
  };
}

export function callCompactTool(client, name, args = {}) {
  return client.callTool(compactCallInput(name, args));
}
