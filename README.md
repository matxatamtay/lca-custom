<div align="center">

<img src="docs/banner.svg" alt="Local Coding Agent" width="760" />

# Local Coding Agent

Trusted local MCP execution engine for ChatGPT with mandatory CodeGraph and AgentMemory context.

</div>

> LCA can read and write files, run commands, manage processes, use Git, and call local desktop integrations with your OS user permissions. It is not an OS sandbox. Connect only trusted projects and clients. See [SECURITY.md](SECURITY.md).

## What ships

ChatGPT sees exactly fifteen tools:

```text
workspace_context  workspace_search  workspace_read   workspace_edit
workspace_exec     workspace_process workspace_git    workspace_verify
workspace_status   workspace_skill   figma            dbeaver
bruno              lca_input
```

`workspace_context` is the default first call for coding tasks. Every call queries three required providers in parallel:

1. current files and ripgrep search
2. CodeGraph structure and impact context
3. AgentMemory project history and decisions

The response includes a coverage receipt so neither graph nor memory can be silently skipped.

Actions execute directly without mode, policy, or approval turns. Project roots help discovery and relative-path routing; absolute paths are supported and roots are not authorization boundaries.

## Quick setup

Requirements:

- Node.js 20+
- npm and Git
- Docker for the default managed AgentMemory engine
- OpenAI tunnel ID and runtime API key for ChatGPT Web

```bash
# macOS, Linux, WSL
bash scripts/lca-custom setup
```

```powershell
# Windows
scripts\lca-custom.cmd setup
```

The installer pins and verifies the core server, CodeGraph `1.5.0`, AgentMemory `0.9.28`, TypeScript output, tunnel client, local config, and service state.

## Daily use

```bash
lca-custom reset /path/to/main-project
lca-custom add /path/to/another-project
lca-custom start --background
lca-custom tui
lca-custom status
lca-custom doctor
```

`lca-custom tui` opens the mouse-enabled terminal dashboard for projects, files, search, mandatory context, Git, commands, processes, verification, tasks, skills, integrations, memory, tools, and logs. Full guide: [docs/TUI.md](docs/TUI.md).

Project changes restart the managed server only when needed. Useful maintenance commands:

```bash
lca-custom primary /path/to/new-primary
lca-custom doctor
lca-custom install --force
lca-custom memory status
lca-custom memory export
lca-custom memory import /path/to/backup.json --dry-run
lca-custom stop
```

## ChatGPT custom app

1. Open ChatGPT Developer mode and create a custom MCP app.
2. Select the private tunnel created during setup.
3. Use `No auth` unless `MCP_AUTH_TOKEN` was intentionally configured locally.
4. Refresh the app after changing the public MCP schema.
5. Call `workspace_status` with `action=info` to verify the project roots and runtime.

Local endpoints:

- MCP: `http://127.0.0.1:8790/mcp`
- Health: `http://127.0.0.1:8790/healthz`

Detailed connector instructions: [docs/CHATGPT_WEB_CONNECTOR.md](docs/CHATGPT_WEB_CONNECTOR.md).

## Architecture

The model-facing MCP server dispatches into an internal in-memory backend containing 136 implementation actions. This preserves precise handlers and compatibility while keeping the tool schema small. Cross-facade dispatch is rejected.

CodeGraph runs through a lazy persistent stdio MCP connection. AgentMemory runs as a separately pinned companion service with automatic health checking, startup, session lifecycle, observations, decision memories, export, and import. Its default lean install uses BM25 without requiring an external LLM key.

Figma, DBeaver, Bruno, and the remote Coolify MCP share persistent Streamable HTTP clients with single-flight connection setup, cached `tools/list`, one retry after transport failure, and graceful close.

More detail and benchmark history: [docs/NEXT_ARCHITECTURE.md](docs/NEXT_ARCHITECTURE.md).

## Persistent memory and task protocol

LCA includes an Obsidian-compatible Markdown vault for durable project context and structured task handoffs. Backend actions include `context_pin`, `context_list`, `context_explain`, `context_remove`, `task_brief`, `intent_check`, `scope_guard`, `knowledge_state`, `parallel_tasks`, `handoff_packet`, `checkpoint`, and `resume`.

`parallel_tasks` runs bounded dependency-aware command lanes; it coordinates shell work and does not spawn additional model agents. Scope guards are opt-in per task, and command/write results include compact result digests. See [Persistent Memory and Shared Task Protocol](docs/PERSISTENT_MEMORY_AND_TASK_PROTOCOL.md).

## Desktop integrations

### Figma

Enable the official Figma Desktop MCP server in Dev Mode. LCA defaults to `http://127.0.0.1:3845/mcp` and exposes it through the single `figma` facade.

### Bruno

Enable Bruno Desktop MCP and configure its local bearer token. LCA exposes collection, folder, request, environment, dotenv, preparation, execution, and retained-result capabilities through the single `bruno` facade.

### Coolify

Set `COOLIFY_MCP_URL` and `COOLIFY_MCP_AUTH_TOKEN` in `.env.local`. LCA exposes the upstream server through the single `coolify` facade; future upstream tools become callable through `coolify_call_tool` without adding another model-facing tool.

### DBeaver

DBeaver SQL is intentionally editor-first:

1. propose visible SQL with `dbeaver_propose_sql`
2. stop and let the user click **Run** in the SQL Artifact
3. the widget receives a hidden short-lived capability
4. DBeaver shows its native confirmation for the exact immutable proposal
5. the widget executes only after confirmation

A model or ordinary MCP client cannot prepare or execute SQL without the widget capability. Generic DBeaver passthrough remains read-only.

## Memory portability

```bash
lca-custom memory export ./lca-memory.json
lca-custom memory import ./lca-memory.json --dry-run
lca-custom memory import ./lca-memory.json
```

Backups use a versioned envelope, stable SHA-256 checksum, atomic writes, and file mode `0600`. Import defaults to `skip`; `replace` requires `--force` and always creates a pre-import backup.

## Validation

```bash
cd server
npm run test:all
```

The release gate covers TypeScript, mandatory context fan-out, persistent MCP clients, desktop bridges, compact schema budgets, Pro behavior, direct trusted execution, transport hardening, and end-to-end evals.

Historical baseline versus the compact runtime:

| Metric | Before | Current target |
|---|---:|---:|
| Model-facing tools | 143 | 15 |
| `tools/list` bytes | 91,420 | under 20,000 |
| Server instruction chars | 4,458 | under 1,000 |

## License

[AGPL-3.0-or-later](LICENSE) © 2026 Lương Duy.
