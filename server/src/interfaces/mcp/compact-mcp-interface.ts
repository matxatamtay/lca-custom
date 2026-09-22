import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { TARGET_TOOL_CATALOG } from "./tool-catalog.js";

export const COMPACT_SERVER_INSTRUCTIONS = [
  "For every coding task call workspace_context first. It always queries current files, native semantic analysis, CodeGraph, and AgentMemory and returns a coverage receipt.",
  "Use the compact facade tools. Each facade accepts a short action alias or an exact hidden backend tool name plus an arguments object. Call action=discover only when you need facade action discovery.",
  "Actions execute directly in the trusted local runtime without policy or approval round-trips. Project roots are discovery defaults, not authorization boundaries.",
  "Batch work, keep outputs bounded, and avoid repeating reads, searches, or commands. For related text lookups, use workspace_search action=text with queries[] in one round-trip. For two or more related edits, prefer one workspace_edit action=batch/apply_patch call; replace_in_file also accepts an ordered replacements array for same-file edits. Use workspace_verify before declaring code changes complete.",
  "Use figma, dbeaver, and bruno for desktop integrations, and coolify for the configured remote Coolify MCP. Use lca_input for the ChatGPT companion UI."
].join("\n");

export interface BackendToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    required?: readonly string[];
    properties?: Readonly<Record<string, unknown>>;
  };
}

interface CompactGroupDefinition {
  defaultAction: string;
  aliases: Readonly<Record<string, string>>;
  exact?: ReadonlySet<string>;
  prefix?: string;
}

export type CompactFacadeName = Exclude<
  (typeof TARGET_TOOL_CATALOG)[number]["name"],
  "workspace_context" | "lca_input" | "notion_page"
>;

export const COMPACT_GROUP_DEFINITIONS: Readonly<Record<CompactFacadeName, CompactGroupDefinition>> = Object.freeze({
  workspace_search: {
    defaultAction: "workspace_search",
    aliases: {
      search: "workspace_search",
      text: "search_text",
      ast: "ast_search",
      files: "find_files",
      symbols: "repo_symbols",
      map: "repo_map",
      overview: "repo_overview",
      important: "important_files",
      index: "index_status",
      todos: "todo_scan",
      definition: "code_definition",
      references: "code_references",
      diagnostics: "code_diagnostics",
      rename: "code_rename_symbol",
      organize_imports: "code_organize_imports"
    },
    exact: new Set([
      "workspace_search", "search_text", "ast_search", "find_files", "repo_symbols", "repo_map", "repo_overview", "important_files", "index_status", "todo_scan",
      "code_definition", "code_references", "code_diagnostics", "code_rename_symbol", "code_organize_imports"
    ])
  },
  workspace_read: {
    defaultAction: "read_many",
    aliases: {
      one: "read_file",
      many: "read_many",
      stat: "stat_path",
      list: "list_files",
      notes: "list_notes",
      resume: "resume",
      memory: "memory_status",
      contexts: "context_list",
      context: "context_explain",
      brief: "task_brief_get",
      intent: "intent_check",
      handoff: "handoff_packet"
    },
    exact: new Set([
      "read_file", "read_many", "stat_path", "list_files", "list_notes", "resume",
      "memory_status", "context_list", "context_explain", "task_brief_get", "intent_check", "handoff_packet"
    ])
  },
  workspace_edit: {
    defaultAction: "apply_patch",
    aliases: {
      patch: "apply_patch",
      batch: "apply_patch",
      preview: "preview_patch",
      validate: "validate_patch",
      undo: "undo_last_patch",
      write: "write_file",
      replace: "replace_in_file",
      mkdir: "make_dir",
      move: "move_path",
      delete: "delete_path",
      note: "save_note",
      checkpoint: "checkpoint",
      decision: "decision_log",
      plan: "task_plan",
      state: "task_state",
      pin_context: "context_pin",
      remove_context: "context_remove",
      brief: "task_brief",
      scope: "scope_guard",
      knowledge: "knowledge_state"
    },
    exact: new Set([
      "apply_patch", "preview_patch", "validate_patch", "undo_last_patch", "write_file", "replace_in_file", "ast_rewrite",
      "make_dir", "move_path", "delete_path", "save_note", "checkpoint", "decision_log", "task_plan", "task_state",
      "context_pin", "context_remove", "task_brief", "scope_guard", "knowledge_state"
    ])
  },
  workspace_exec: {
    defaultAction: "run_commands",
    aliases: { one: "run_command", many: "run_commands", parallel: "parallel_tasks", code: "run_code" },
    exact: new Set(["run_command", "run_commands", "parallel_tasks", "run_code"])
  },
  workspace_process: {
    defaultAction: "proc_list",
    aliases: { start: "proc_start", list: "proc_list", output: "proc_output", wait: "proc_wait", stop: "proc_stop" },
    prefix: "proc_"
  },
  workspace_git: {
    defaultAction: "git_status",
    aliases: {
      run: "git",
      status: "git_status",
      diff: "git_diff",
      worktree_create: "worktree_create",
      worktree_status: "worktree_status",
      worktree_diff: "worktree_diff",
      worktree_check: "worktree_check",
      worktree_gc: "worktree_gc",
      worktree_cleanup: "worktree_cleanup"
    },
    exact: new Set(["git", "git_status", "git_diff", "worktree_create", "worktree_status", "worktree_diff", "worktree_check", "worktree_gc", "worktree_cleanup"])
  },
  workspace_verify: {
    defaultAction: "quality_gate",
    aliases: {
      plan: "verification_plan",
      detect: "detect_test_commands",
      gate: "quality_gate",
      tests: "run_tests",
      changed: "run_changed_tests",
      plan_changed: "verify_changed",
      build: "run_build",
      lint: "run_lint",
      review: "review_diff",
      security: "security_scan",
      semgrep: "semgrep_scan",
      regression_rules: "semgrep_rules",
      mutation: "mutation_test",
      summary: "change_summary",
      session: "session_report"
    },
    exact: new Set(["verification_plan", "detect_test_commands", "quality_gate", "verify_changed", "run_tests", "run_changed_tests", "run_build", "run_lint", "review_diff", "security_scan", "semgrep_scan", "semgrep_rules", "mutation_test", "change_summary", "session_report"])
  },
  workspace_ui: {
    defaultAction: "ui_status",
    aliases: {
      status: "ui_status",
      browser_actions: "ui_browser_actions",
      browser_call: "ui_browser_call",
      devices: "ui_android_devices",
      adb: "ui_android_adb",
      screenshot: "ui_android_screenshot",
      hierarchy: "ui_android_hierarchy",
      input: "ui_android_input",
      logcat: "ui_android_logcat",
      record: "ui_android_record"
    },
    prefix: "ui_"
  },
  workspace_status: {
    defaultAction: "workspace_info",
    aliases: {
      info: "workspace_info",
      performance: "performance_follow",
      improvements: "improvement_candidates",
      dependencies: "dependency_feed",
      performance_profile: "performance_profile",
      trace: "tool_trace",
      doctor: "workspace_doctor",
      snapshot: "workspace_snapshot",
      profile: "project_profile",
      loaded_profile: "profile_status",
      reload_profile: "reload_profile",
      ping: "ping"
    },
    exact: new Set(["ping", "workspace_info", "performance_follow", "improvement_candidates", "dependency_feed", "performance_profile", "tool_trace", "lca", "workspace_doctor", "workspace_snapshot", "project_profile", "profile_status", "reload_profile"])
  },
  workspace_skill: {
    defaultAction: "list_skills",
    aliases: { list: "list_skills", read: "read_skill", create: "create_skill", delete: "delete_skill", slash: "slash_commands", compose: "compose_prompt" },
    exact: new Set(["list_skills", "read_skill", "create_skill", "delete_skill", "slash_commands", "compose_prompt"])
  },
  figma: {
    defaultAction: "figma_status",
    aliases: {
      status: "figma_status",
      actions: "figma_list_tools",
      call: "figma_call_tool",
      remote_status: "figma_remote_status",
      remote_actions: "figma_remote_list_tools",
      remote_call: "figma_remote_call_tool",
      auth: "figma_remote_auth_start",
      reset_auth: "figma_remote_auth_reset"
    },
    prefix: "figma_"
  },
  dbeaver: {
    defaultAction: "dbeaver_status",
    aliases: { status: "dbeaver_status", actions: "dbeaver_list_tools", call: "dbeaver_call_tool", propose: "dbeaver_propose_sql" },
    prefix: "dbeaver_"
  },
  bruno: {
    defaultAction: "bruno_status",
    aliases: { status: "bruno_status", actions: "bruno_list_tools", call: "bruno_call_tool", run: "bruno_run_request" },
    prefix: "bruno_"
  },
  penpot: {
    defaultAction: "penpot_status",
    aliases: {
      status: "penpot_status",
      actions: "penpot_list_tools",
      call: "penpot_call_tool",
      read: "penpot_read_tool",
      inspect: "penpot_inspect_page",
      selection: "penpot_inspect_selection",
      export: "penpot_export_shape",
      mutate: "penpot_execute_code",
      destructive: "penpot_execute_destructive_code"
    },
    prefix: "penpot_"
  },
  coolify: {
    defaultAction: "coolify_status",
    aliases: {
      status: "coolify_status",
      actions: "coolify_list_tools",
      call: "coolify_call_tool",
      read: "coolify_read_tool",
      mutate: "coolify_mutate_tool",
      destructive: "coolify_destructive_tool"
    },
    prefix: "coolify_"
  },
  notion: {
    defaultAction: "notion_status",
    aliases: {
      status: "notion_status",
      actions: "notion_capabilities",
      search: "notion_search",
      fetch: "notion_fetch_page",
      create: "notion_create_page",
      update: "notion_update_markdown",
      replace: "notion_replace_markdown",
      call: "notion_call"
    },
    prefix: "notion_"
  }
});

export const COMPACT_TOOL_DESCRIPTIONS: Readonly<Record<CompactFacadeName, string>> = Object.freeze({
  workspace_search: "Search structural AST patterns, files, text, symbols, repository maps, graph-oriented indexes, and TODOs. Prefer action=ast for exact syntax structure, semantic symbol actions next, and action=text for plain text. Batch related text queries with arguments.queries[].",
  workspace_read: "Read one or many files, stat paths, list files or notes, and resume checkpoints. Common actions: one, many, stat, list, notes, resume.",
  workspace_edit: "Apply, preview, validate, and undo patches; run bounded ast-grep structural rewrites; write, replace, move, or delete paths; maintain notes and task state. Use action=ast_rewrite for safe codemods and action=batch/apply_patch for ordinary related edits.",
  workspace_exec: "Run bounded foreground commands. Common actions: one or many.",
  workspace_process: "Start, list, inspect output from, and stop managed background processes.",
  workspace_git: "Run Git commands, compact status/diffs, and LCA-managed isolated worktrees for parallel tasks.",
  workspace_verify: "Detect and run focused lint, typecheck, test, build, review, security, local Semgrep regression/invariant scans, learned-rule lifecycle management, incremental mutation testing, and session-report gates.",
  workspace_ui: "Inspect and control trusted-local browser tabs and connected Android devices.",
  workspace_status: "Inspect workspace, trusted runtime, project profile, readiness, long-lived performance metrics, ranked self-improvement candidates, and advisory dependency feeds.",
  workspace_skill: "Discover, read, create, and delete reusable skills, or compose companion prompts.",
  figma: "Use Figma Remote MCP with OAuth and guarded canvas writes, plus the persistent Desktop fallback. Common actions: status, actions, call, auth, remote_status, remote_actions, remote_call, or an exact figma_* backend action.",
  dbeaver: "Use the persistent DBeaver Desktop integration. Common actions: status, actions, call, propose, or an exact dbeaver_* backend action.",
  bruno: "Use the persistent Bruno Desktop integration. Common actions: status, actions, call, run, or an exact bruno_* backend action.",
  penpot: "Use the local Penpot MCP integration. Common actions: status, actions, read, inspect, selection, export, mutate, destructive, call, or an exact penpot_* backend action.",
  coolify: "Use the pinned local Coolify MCP stdio integration. Common actions: status, actions, read, mutate, destructive, call, or an exact coolify_* backend action.",
  notion: "Use the Notion REST API integration. Common actions: status, actions, search, fetch, create, update, replace, call, or an exact notion_* backend action. AI-generated edits must be staged through notion_page for preview and explicit Apply approval before update/replace is used."
});

export interface CompactMcpInterfaceDependencies {
  registerTool(
    mcp: McpServer,
    name: string,
    definition: Record<string, unknown>,
    handler: (args: Record<string, unknown>, extra?: unknown) => unknown | Promise<unknown>
  ): void;
  callBackendTool(name: string, args?: Record<string, unknown>, project?: string): Promise<unknown>;
  listBackendTools(): Promise<readonly BackendToolDefinition[]>;
  registerLcaInputTool(mcp: McpServer, name: string, title: string, description: string): void;
  structuredJsonResult(value: unknown): unknown;
}

export function registerCompactMcpTools(
  mcp: McpServer,
  dependencies: CompactMcpInterfaceDependencies
): void {
  dependencies.registerTool(
    mcp,
    "workspace_context",
    {
      title: "Workspace context",
      description: "Build task context by always querying current filesystem search, native semantic analysis, CodeGraph, and AgentMemory in parallel. Use this first for coding tasks.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        task: z.string().min(1).describe("Concrete coding task or question."),
        project: z.string().optional().describe("Conversation-scoped primary project or folder selected in lca_input."),
        path: z.string().optional().describe("Root or subdirectory to inspect. When omitted, the backend may select a uniquely mentioned configured project from the task."),
        intent: z.enum(["understand", "debug", "implement", "refactor", "review"]).optional(),
        changed_files: z.array(z.string()).optional(),
        max_items: z.number().int().min(3).max(50).optional(),
        max_chars: z.number().int().min(1000).max(100000).optional()
      }
    },
    async (rawArgs) => {
      const { project, ...args } = rawArgs;
      return dependencies.callBackendTool("workspace_context", args, nonEmptyString(project));
    }
  );

  for (const facade of facadeNames()) {
    const definition = COMPACT_GROUP_DEFINITIONS[facade];
    dependencies.registerTool(
      mcp,
      facade,
      {
        title: facade.replaceAll("_", " "),
        description: `${COMPACT_TOOL_DESCRIPTIONS[facade]} Use action=discover to list exact backend actions and their input keys.`,
        inputSchema: {
          action: z.string().optional().describe(`Short alias or exact backend tool name. Default: ${definition.defaultAction}. Use discover for available actions.`),
          project: z.string().optional().describe("Conversation-scoped primary project or folder selected in lca_input. Relative paths and default discovery use it only for this tool call."),
          arguments: z.record(z.any()).optional().describe("Arguments forwarded unchanged to the selected backend tool.")
        }
      },
      async (rawArgs) => {
        const action = nonEmptyString(rawArgs.action) ?? definition.defaultAction;
        const forwardedArguments = asRecord(rawArgs.arguments);
        if (action === "discover") {
          return dependencies.structuredJsonResult(
            describeCompactActions(facade, await dependencies.listBackendTools())
          );
        }
        const hiddenTool = resolveCompactAction(facade, action, await dependencies.listBackendTools());
        return dependencies.callBackendTool(hiddenTool, forwardedArguments, nonEmptyString(rawArgs.project));
      }
    );
  }

  dependencies.registerLcaInputTool(
    mcp,
    "lca_input",
    "LCA input",
    "Render the compact LCA Apps SDK input widget inside ChatGPT."
  );
}

export function resolveCompactAction(
  facade: CompactFacadeName,
  requestedAction: string,
  tools: readonly BackendToolDefinition[]
): string {
  const definition = COMPACT_GROUP_DEFINITIONS[facade];
  const action = definition.aliases[requestedAction] ?? requestedAction;
  const tool = tools.find((candidate) => candidate.name === action);
  if (!tool || !compactDefinitionContains(definition, action)) {
    const aliases = Object.keys(definition.aliases).join(", ");
    throw new Error(`Unknown ${facade} action '${requestedAction}'. Use action=discover. Common aliases: ${aliases || "none"}.`);
  }
  return action;
}

export function describeCompactActions(
  facade: CompactFacadeName,
  tools: readonly BackendToolDefinition[]
): {
  facade: CompactFacadeName;
  default_action: string;
  actions: Array<{
    name: string;
    aliases: string[];
    description: string;
    required: readonly string[];
    input_keys: string[];
  }>;
} {
  const definition = COMPACT_GROUP_DEFINITIONS[facade];
  const actions = tools
    .filter((tool) => compactDefinitionContains(definition, tool.name))
    .map((tool) => ({
      name: tool.name,
      aliases: Object.entries(definition.aliases)
        .filter(([, target]) => target === tool.name)
        .map(([alias]) => alias),
      description: tool.description ?? "",
      required: tool.inputSchema?.required ?? [],
      input_keys: Object.keys(tool.inputSchema?.properties ?? {})
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { facade, default_action: definition.defaultAction, actions };
}

export function compactDefinitionContains(definition: CompactGroupDefinition, toolName: string): boolean {
  return Boolean(definition.exact?.has(toolName) || (definition.prefix && toolName.startsWith(definition.prefix)));
}

export function facadeNames(): readonly CompactFacadeName[] {
  const excluded = new Set<string>(["workspace_context", "lca_input", "notion_page"]);
  return TARGET_TOOL_CATALOG
    .map((tool) => tool.name)
    .filter((name) => !excluded.has(name)) as readonly CompactFacadeName[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
