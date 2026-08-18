export interface TargetToolDefinition {
  name: string;
  description: string;
}

export const TARGET_TOOL_CATALOG = Object.freeze([
  {
    name: "workspace_context",
    description: "Build task context by always querying filesystem search, CodeGraph, and AgentMemory in parallel."
  },
  { name: "workspace_search", description: "Search files, text, symbols, graph relationships, and remembered project context." },
  { name: "workspace_read", description: "Read one or many files and targeted line ranges." },
  { name: "workspace_edit", description: "Apply related edits and optionally verify changed files in the same call." },
  { name: "workspace_exec", description: "Run bounded foreground commands." },
  { name: "workspace_process", description: "Start, inspect, and stop managed background processes." },
  { name: "workspace_git", description: "Run Git operations and return compact repository state." },
  { name: "workspace_verify", description: "Detect and run focused lint, typecheck, test, and build gates." },
  { name: "workspace_agent", description: "Run delegated model agents, dependency DAGs, isolated worktrees, and explicit conflict-checked merges." },
  { name: "workspace_ui", description: "Inspect and control trusted-local browser tabs and connected Android devices without LCA approval round-trips." },
  { name: "workspace_status", description: "Return runtime, dependency, project, graph-index, and memory health." },
  { name: "workspace_skill", description: "Discover, read, create, and delete reusable project skills." },
  { name: "figma", description: "Call the persistent Figma Desktop integration through named actions." },
  { name: "dbeaver", description: "Call the persistent DBeaver Desktop integration through named actions." },
  { name: "bruno", description: "Call the persistent Bruno Desktop integration through named actions." },
  { name: "penpot", description: "Read, inspect, export, and edit Penpot directly in the trusted-local runtime." },
  { name: "coolify", description: "Call the pinned Coolify MCP integration directly in the trusted-local runtime." },
  { name: "notion", description: "Search, read, create, and safely update Notion pages through the configured Notion API connection." },
  { name: "lca_input", description: "Render the compact ChatGPT companion input widget." },
  { name: "notion_page", description: "Render an interactive Notion page viewer/editor with staged edit previews and explicit Apply approval inside ChatGPT." }
] as const satisfies readonly TargetToolDefinition[]);
