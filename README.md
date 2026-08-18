<div align="center">

<img src="docs/banner.svg" alt="Local Coding Agent" width="760" />

# Local Coding Agent

Trusted local MCP execution engine for ChatGPT with mandatory CodeGraph and AgentMemory context.

</div>

> LCA can read and write files, run commands, manage processes, use Git, and call local desktop integrations with your OS user permissions. It is not an OS sandbox. Connect only trusted projects and clients. See [SECURITY.md](SECURITY.md).

## What ships

ChatGPT sees exactly twenty tools:

```text
workspace_context  workspace_search  workspace_read   workspace_edit
workspace_exec     workspace_process workspace_git    workspace_verify
workspace_agent    workspace_ui      workspace_status workspace_skill
figma              dbeaver           bruno            penpot
coolify            notion            lca_input        notion_page
```

`workspace_context` is the default first call for coding tasks. Every call queries three required providers in parallel:

1. current files and ripgrep search
2. CodeGraph structure and impact context
3. AgentMemory project history and decisions

The response includes a coverage receipt so neither graph nor memory can be silently skipped.

Actions execute directly without mode, policy, or approval turns. Project roots help discovery and relative-path routing; absolute paths are supported and roots are not authorization boundaries.

## Accelerated coding workflow

The compact workspace facades now cover the full edit-and-run loop without forcing repeated model-side polling or manual app testing:

- **Context Retrieval V2** filters generated/vendor/license noise, reranks filesystem hits with changed-file and CodeGraph hints, balances providers, semantically deduplicates results, and enforces a global character budget.
- **`workspace_agent`** delegates coding work to a runner-neutral agent layer. Codex is the first adapter and supports single jobs, parallel jobs, dependency DAGs, cancellation, structured collection, and explicit cleanup.
- Writable delegated jobs default to **detached git worktrees**. The worktree inherits the current tracked and bounded untracked working-tree state into an ephemeral baseline, then emits only the delegated delta. `agent_merge` runs scope validation and `git apply --check` before touching the source tree; conflicts leave it unchanged.
- **`workspace_ui`** bridges approved Chromium tabs through Local Browser Agent and connected Android devices through ADB for screenshots, UI hierarchy, input, logcat, app launch/stop, and short screen recordings.
- **`workspace_process.wait`** waits server-side for process exit, output regexes, TCP ports, HTTP health, or file events instead of consuming repeated MCP polling turns.
- **Compiler-native code intelligence** uses TypeScript 7 LSP for definitions, references, semantic rename, and organize-imports, plus the native compiler API for structured diagnostics. Other languages retain bounded text fallbacks where a semantic provider is unavailable.
- **Verification intelligence** builds a changed-file/risk/affected-test plan, runs dependency-aware targeted tests where possible, and parses compiler/test output into structured file/line diagnostics.
- **Performance profiling** records only tool name, facade/backend surface, success, latency, and input/output character counts. `workspace_status` exposes recent trace metadata and aggregated p50/p95/failure/payload signals without retaining tool arguments or output content.

`parallel_tasks` remains the lightweight shell DAG. Use `workspace_agent` when independent work benefits from actual model agents and isolated writable worktrees.

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

The model-facing MCP server dispatches into a larger internal in-memory implementation-action surface. This preserves precise handlers and compatibility while keeping the public tool schema small. Cross-facade dispatch is rejected.

CodeGraph runs through a lazy persistent stdio MCP connection. AgentMemory runs as a separately pinned companion service with automatic health checking, startup, session lifecycle, observations, decision memories, export, and import. Its default lean install uses BM25 without requiring an external LLM key.

Figma, DBeaver, Bruno, and Penpot use persistent local MCP clients. Coolify uses the pinned local `@masonator/coolify-mcp` stdio process. Notion uses the official REST API through a masked local bearer token and adds a dedicated ChatGPT page widget.

`lca-custom tui` includes a Config screen that reads and edits the repository `.env.local`, masks secret values, writes with mode `600` where supported, and exposes Start, Stop, and Restart controls. The Integrations screen also provides a censored **Notion Key** action. The launcher reloads the latest file before each lifecycle command, so changing a Bruno, Penpot, Coolify, or Notion token does not require leaving the TUI.

More detail and benchmark history: [docs/NEXT_ARCHITECTURE.md](docs/NEXT_ARCHITECTURE.md).

## Persistent memory and task protocol

LCA includes an Obsidian-compatible Markdown vault for durable project context and structured task handoffs. Backend actions include `context_pin`, `context_list`, `context_explain`, `context_remove`, `task_brief`, `intent_check`, `scope_guard`, `knowledge_state`, `parallel_tasks`, `handoff_packet`, `checkpoint`, and `resume`.

`parallel_tasks` runs bounded dependency-aware command lanes; it coordinates shell work and does not spawn additional model agents. `workspace_agent` is the separate model-agent orchestration layer. Scope guards are opt-in per task, and command/write results include compact result digests. See [Persistent Memory and Shared Task Protocol](docs/PERSISTENT_MEMORY_AND_TASK_PROTOCOL.md).

## Delegated agent providers and fallback

`workspace_agent` can run Codex against server-side OpenAI-compatible provider credentials. The MCP call never accepts raw API keys: configure provider metadata in `LCA_AGENT_PROVIDERS_JSON`, point `api_key_env` at a separate secret variable, then define the normal order in `LCA_AGENT_PROVIDER_CHAIN`.

```dotenv
LCA_AGENT_PROVIDERS_JSON=[{"name":"primary","base_url":"https://provider-a.example/v1","api_key_env":"AGENT_PRIMARY_API_KEY","model":"model-a"},{"name":"backup","base_url":"https://provider-b.example/v1","api_key_env":"AGENT_BACKUP_API_KEY","model":"model-b"}]
LCA_AGENT_PROVIDER_CHAIN=primary,backup,codex
AGENT_PRIMARY_API_KEY=...
AGENT_BACKUP_API_KEY=...
```

The reserved `codex` provider preserves the existing Codex authentication/endpoint behavior and can be placed anywhere in the chain. You can also override routing for one task with `provider: "backup"` or `provider_chain: ["backup", "codex"]`. Automatic fallback happens for exhausted credit/quota, HTTP 429/rate limiting, timeouts/network failures, and provider 5xx/overload errors. Authentication failures, bad requests, and unknown models stay visible instead of silently routing elsewhere. Retryable failures put that provider on an in-memory cooldown so later jobs skip it temporarily; explicitly selecting one provider bypasses cooldown.

OpenAI-compatible delegated providers must support the Responses API used by the bundled Codex CLI. A gateway that only exposes Chat Completions is not treated as compatible. Set `output_schema: false` for gateways that support Responses but not JSON-schema structured output. Use `lca-custom tui` → **Config** → **Add** to store these variables locally; key-like variable names are masked and `.env.local` is written with restricted permissions. Restart LCA after changing provider configuration.

## Desktop integrations

### Figma

Enable the official Figma Desktop MCP server in Dev Mode. LCA defaults to `http://127.0.0.1:3845/mcp` and exposes it through the single `figma` facade.

### Bruno

Enable Bruno Desktop MCP and configure its local bearer token. LCA exposes collection, folder, request, environment, dotenv, preparation, execution, and retained-result capabilities through the single `bruno` facade.

### Penpot

Run the Penpot stack, open the target design file, and connect MCP from Penpot. Keep the endpoint token-free in `PENPOT_MCP_URL` and store the generated credential separately in `PENPOT_USER_TOKEN`. The single `penpot` facade provides page/selection inspection, Plugin API lookup, PNG/SVG export, and direct drawing/edit/delete execution in trusted-local mode. Read/mutate/destructive aliases remain compatibility labels, not LCA permission gates.

### Coolify

Set `COOLIFY_BASE_URL` and `COOLIFY_ACCESS_TOKEN` in `.env.local`. LCA starts the pinned `@masonator/coolify-mcp` package over local stdio and exposes it through the single `coolify` facade. All live upstream operations can execute directly in trusted-local mode; `read`, `mutate`, and `destructive` remain compatibility aliases and classification metadata rather than LCA approval barriers. Upstream Coolify roles/scopes still apply normally.

## Runtime trajectory, recovery, and Code Mode

LCA records an append-only runtime event stream under its local workspace data directory. `workspace_status action=trace` projects that stream into a correlation-grouped trajectory, and `lca_input` can display the same trace tree. Tool metrics and AgentMemory observations consume the shared action pipeline instead of instrumenting separate execution paths. Optional OTLP/HTTP export is enabled with `OTEL_EXPORTER_OTLP_ENDPOINT`; JSONL remains the local source of truth.

Delegated Codex jobs default to `danger-full-access`, network enabled, and isolated worktrees. Job/DAG descriptors are persisted for restart reconstruction, with active pre-crash work reported honestly as recoverable or orphaned. `workspace_exec action=code` can combine multiple LCA backend actions in one TypeScript worker program; every nested binding still re-enters the ordinary backend pipeline and correctness checks.

### Notion

Open `lca-custom tui` → **Integrations** → **Notion Key**, paste the Notion integration token, then restart LCA. The single `notion` facade supports status, search, enhanced-Markdown fetch, create, targeted update, conflict-checked replacement, and allow-listed forward-compatible API calls. `notion_page` renders an interactive page app inside ChatGPT with search, read/edit, fullscreen, **Add to ChatGPT**, **Ask ChatGPT**, and selected block/text context. `lca_input` also supports lazy `@notion:<query>` autocomplete. See [docs/NOTION.md](docs/NOTION.md).

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
| Model-facing tools | 143 | 20 |
| `tools/list` bytes | 91,420 | under 24,000 |
| Server instruction chars | 4,458 | under 1,000 |

## License

[AGPL-3.0-or-later](LICENSE) © 2026 Lương Duy.
