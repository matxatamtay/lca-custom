<div align="center">

<img src="docs/banner.svg" alt="Local Coding Agent" width="760" />

# Local Coding Agent

Trusted local MCP execution engine for ChatGPT with native semantic analysis, CodeGraph, and AgentMemory context.

</div>

> LCA can read and write files, run commands, manage processes, use Git, and call local desktop integrations with your OS user permissions. It is not an OS sandbox. Connect only trusted projects and clients. See [SECURITY.md](SECURITY.md).

## What ships

ChatGPT sees exactly nineteen tools:

```text
workspace_context  workspace_search  workspace_read   workspace_edit
workspace_exec     workspace_process workspace_git    workspace_verify
workspace_ui       workspace_status  workspace_skill  figma
dbeaver            bruno             penpot           coolify
notion             lca_input         notion_page
```

`workspace_context` is the default first call for coding tasks. Every call queries four context lanes in parallel:

1. current files and ripgrep search
2. language-native semantic analysis for exact symbols and references
3. CodeGraph structure and impact context
4. AgentMemory project history and decisions

The response includes a coverage receipt for all four lanes. CodeGraph and AgentMemory remain required; semantic analysis reports `unavailable` explicitly when a language backend is not ready.

Actions execute directly without mode, policy, or approval turns. Project roots help discovery and relative-path routing; absolute paths are supported and roots are not authorization boundaries.

## Accelerated coding workflow

The compact workspace facades now cover the full edit-and-run loop without forcing repeated model-side polling or manual app testing:

- **Context Retrieval V2** filters generated/vendor/license noise, reranks filesystem hits with changed-file and CodeGraph hints, balances providers, semantically deduplicates results, and enforces a global character budget.
- **`workspace_ui`** bridges approved Chromium tabs through Local Browser Agent and connected Android devices through ADB for screenshots, UI hierarchy, input, logcat, app launch/stop, and short screen recordings.
- **`workspace_process.wait`** waits server-side for process exit, output regexes, TCP ports, HTTP health, or file events instead of consuming repeated MCP polling turns.
- **Compiler-native code intelligence** uses TypeScript 7 LSP for definitions, references, semantic rename, and organize-imports, plus the native compiler API for structured diagnostics. Other languages retain bounded text fallbacks where a semantic provider is unavailable.
- **Verification intelligence** builds a changed-file/risk/affected-test plan, runs dependency-aware targeted tests where possible, and parses compiler/test output into structured file/line diagnostics.
- **Performance profiling** records only tool name, facade/backend surface, success, latency, and input/output character counts. `workspace_status` exposes recent trace metadata and aggregated p50/p95/failure/payload signals without retaining tool arguments or output content.

`parallel_tasks` remains the lightweight shell DAG for direct local command work; it does not spawn or delegate to additional models.

## Quick setup

### 1. Requirements

- Node.js 20+
- npm and Git
- Docker for the default managed AgentMemory engine
- OpenAI tunnel ID and runtime API key only when connecting ChatGPT Web through the managed private tunnel

Check the basics first:

```bash
node --version
npm --version
git --version
docker --version
```

### 2. Clone and run the setup wizard

```bash
git clone https://github.com/matxatamtay/lca-custom.git
cd lca-custom

# macOS, Linux, WSL
bash scripts/lca-custom setup
```

Windows:

```powershell
git clone https://github.com/matxatamtay/lca-custom.git
cd lca-custom
scripts\lca-custom.cmd setup
```

The setup wizard installs/verifies the core server, CodeGraph `1.5.0`, AgentMemory `0.9.28`, TypeScript output, tunnel client, global `lca-custom` command, local config, and managed service state. Secrets are written to local configuration only; do not commit `.env.local`.

### 3. Select workspaces and start LCA

```bash
# Replace the primary project and remove stale configured roots.
lca-custom reset /absolute/path/to/main-project

# Add peer repositories when one task spans multiple repos.
lca-custom add /absolute/path/to/another-project

# Start the managed server and private tunnel in the background.
lca-custom start --background

# Verify runtime and dependencies.
lca-custom status
lca-custom doctor
```

For local-only development without the managed tunnel:

```bash
lca-custom start --background --no-tunnel
```

Default local endpoints:

- MCP: `http://127.0.0.1:8790/mcp`
- Health: `http://127.0.0.1:8790/healthz`

A quick health check:

```bash
curl -fsS http://127.0.0.1:8790/healthz
```

### 4. Manual/developer setup

Use this path when developing LCA itself and you do not need the managed installer:

```bash
git clone https://github.com/matxatamtay/lca-custom.git
cd lca-custom/server
npm ci
npm start
```

Or run the server directly after building:

```bash
cd server
npm run build:next
PORT=8790 AGENT_WORKSPACE=/absolute/path/to/project node server.mjs
```

On Windows PowerShell:

```powershell
cd server
npm ci
npm run build:next
$env:PORT = "8790"
$env:AGENT_WORKSPACE = "C:\path\to\project"
node server.mjs
```

This development path does not install the global `lca-custom` wrapper or configure the managed tunnel automatically.

### 5. Restart after runtime/config changes

```bash
lca-custom stop
lca-custom start --background
lca-custom doctor
```

A restart is required after changing server code, the compact MCP schema, or environment variables consumed only at startup.

### Optional self-improvement tooling

The core runtime starts without these tools. Install only the sensors you want:

| Tool | Used for | Behavior when missing |
|---|---|---|
| `ast-grep` | structural search and bounded AST rewrite planning | `workspace_search ast` / AST maintenance checks report unavailable |
| Semgrep | invariant, security, and learned regression scans | `workspace_verify semgrep` reports `available=false` |
| StrykerJS | incremental mutation testing | `workspace_verify mutation` reports `available=false` |
| Renovate | dependency intelligence source | LCA still works; dependency feed is unavailable unless a local report exists |

Binary discovery can be overridden in `.env.local`:

```dotenv
AST_GREP_BIN=/absolute/path/to/ast-grep
SEMGREP_BIN=/absolute/path/to/semgrep
STRYKER_BIN=/absolute/path/to/stryker
RENOVATE_BIN=/absolute/path/to/renovate
RENOVATE_FEED_PATH=/absolute/path/to/renovate-feed.json
```

Renovate remains advisory: LCA reads JSON/JSONL feed data but does not execute Renovate updates automatically. Semgrep/Stryker are also on-demand and never become mandatory `workspace_context` providers.

## Daily use

```bash
lca-custom reset /path/to/main-project
lca-custom add /path/to/another-project
lca-custom start --background
lca-custom tui
lca-custom status
lca-custom doctor

# Analysis-only self-improvement report.
lca-custom improve

# Full analysis-only maintenance sweep.
lca-custom improve --maintenance

# Apply at most one explicitly low-risk deterministic candidate.
lca-custom improve --maintenance --apply-safe

# Apply one exact deterministic candidate by id.
lca-custom improve --apply <candidate-id>
```

`lca-custom improve` is analysis-only by default. It ranks current self-improvement candidates without editing source files or dependencies. Filters: `--latest`, `--performance`, `--tests`, `--dependencies`, and `--security`. `lca-custom improve --apply <candidate-id>` is explicit-only and accepts only bounded deterministic `workspace_edit.apply_patch` recipes stored on the candidate; unsupported candidates are refused before the local MCP server is contacted. Apply execution uses `workspace_context`, before/after `performance_follow` snapshots, and fused `workspace_edit` changed verification. A before/after evaluator then requires measurable evidence beyond a bounded noise threshold: performance/reliability use allowlisted `performance_follow` metrics, TEST_QUALITY uses the candidate's exact Stryker rerun when available, and SECURITY uses local Semgrep severity counts. Passing tests alone never accepts an improvement; a non-improving or regressing patch is immediately reverted through `workspace_edit undo`. Only an accepted, non-regressing improvement is persisted into the existing project-scoped AgentMemory as durable `fact` knowledge, including candidate/problem evidence, deterministic solution summary, before/after metrics, verification, affected paths, and regression-rule references when present. Future `workspace_context` calls can retrieve that memory through the existing AgentMemory provider; rejected or reverted candidates are never stored as successful improvement knowledge. `lca-custom improve --maintenance` runs the Phase 16 analysis-only maintenance sweep across performance history, Semgrep, ast-grep direct-only architecture signatures, incremental Stryker mutation telemetry, Renovate dependency feed, dependency/security state, cache behavior, Jev behavior, and CodeGraph behavior, then ranks the top candidates. `--apply-safe` is explicit and applies at most one candidate carrying a bounded deterministic recipe with an allowlisted safe class and `risk=low`; known-regression fixes require a rule reference, patch dependency updates additionally require low-risk patch metadata plus a full-green-gate marker, and architectural redesign is always refused. It never invokes a secondary model, automatic package updater, commit, or push. The final roadmap acceptance bundle is available as `npm run test:self-improvement` from `server/`; it checks the direct-only architecture invariants, self-improvement core/sensors/evaluator/maintenance tests, and the compact MCP surface together.

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

The model-facing MCP server exposes nineteen public tools and currently dispatches into an internal in-memory backend containing 176 hidden implementation actions. This preserves precise handlers and compatibility while keeping the tool schema small. Cross-facade dispatch is rejected.

The runtime is direct-only: LCA does not contain a Codex/Hermes/sub-agent delegation path. `workspace_context`, CodeGraph, AgentMemory, Jev, edits, verification, Git, and local integrations execute through the local LCA runtime itself.

Language-native semantic analysis runs in parallel with CodeGraph. TypeScript/JavaScript uses a persistent TypeScript 7 native API/tsgo session. Dart/Flutter uses the project Dart Analysis Server over persistent LSP with background cold prewarming, so the first context call reports `warming` instead of blocking. Java uses a persistent Eclipse JDT LS session with project-isolated workspace metadata; the checksum-pinned JDT runtime lives under ignored `runtime/jdtls/` and can be provisioned with `node scripts/jdtls-runtime.mjs install`. All three return compact definition/reference locations instead of duplicating source bodies.

CodeGraph remains required but is routed by intent: ordinary symbol tasks use location-only graph search, callers/callees and refactors use narrow relationship tools, and full source-bearing exploration is reserved for architecture/flow work. Results are cached by project + graph revision + normalized query, while changed files force graph refresh/invalidation. AgentMemory remains the separately pinned companion service with managed health, lifecycle, observations, decisions, export, and import.

Figma Desktop, Figma Remote, DBeaver, Bruno, and the remote Coolify MCP use persistent Streamable HTTP connections with cached `tools/list` and graceful close. Figma Remote adds OAuth PKCE with local `0600` token storage and a fail-closed write guard.

More detail and benchmark history: [docs/NEXT_ARCHITECTURE.md](docs/NEXT_ARCHITECTURE.md).

## Persistent memory and task protocol

LCA includes an Obsidian-compatible Markdown vault for durable project context and structured task handoffs. Backend actions include `context_pin`, `context_list`, `context_explain`, `context_remove`, `task_brief`, `intent_check`, `scope_guard`, `knowledge_state`, `parallel_tasks`, `handoff_packet`, `checkpoint`, and `resume`.

`parallel_tasks` runs bounded dependency-aware command lanes and never spawns additional model agents. Scope guards are opt-in per task, and command/write results include compact result digests. See [Persistent Memory and Shared Task Protocol](docs/PERSISTENT_MEMORY_AND_TASK_PROTOCOL.md).

## Desktop integrations

### Figma

LCA supports both official Figma MCP transports through the single `figma` facade:

- Remote, preferred: `https://mcp.figma.com/mcp`, OAuth PKCE, link-based reads, and guarded write-to-canvas tools such as `use_figma`.
- Desktop fallback: `http://127.0.0.1:3845/mcp`, using the current Figma Desktop selection in Dev Mode.

Enable Remote in `.env.local` with `FIGMA_REMOTE_ENABLED=1`. Canvas writes remain blocked unless `FIGMA_REMOTE_ALLOW_WRITE=1`. Start authorization with the `figma` facade action `auth`, open the returned URL, and let Figma redirect to LCA's loopback callback. OAuth tokens and PKCE state are stored outside the repository with file mode `0600`.

Figma currently limits its hosted MCP endpoint to clients in the Figma MCP Catalog. The bridge reports that restriction plainly if Figma rejects LCA's client registration; it never impersonates another supported client.

### Bruno

Enable Bruno Desktop MCP and configure its local bearer token. LCA exposes collection, folder, request, environment, dotenv, preparation, execution, and retained-result capabilities through the single `bruno` facade.

### Penpot

Run the Penpot stack, open the target design file, and connect MCP from Penpot. Keep the endpoint token-free in `PENPOT_MCP_URL` and store the generated credential separately in `PENPOT_USER_TOKEN`. The single `penpot` facade provides page/selection inspection, Plugin API lookup, PNG/SVG export, and direct drawing/edit/delete execution in trusted-local mode. Read/mutate/destructive aliases remain compatibility labels, not LCA permission gates.

### Coolify

Set `COOLIFY_BASE_URL` and `COOLIFY_ACCESS_TOKEN` in `.env.local`. LCA starts the pinned `@masonator/coolify-mcp` package over local stdio and exposes it through the single `coolify` facade. All live upstream operations can execute directly in trusted-local mode; `read`, `mutate`, and `destructive` remain compatibility aliases and classification metadata rather than LCA approval barriers. Upstream Coolify roles/scopes still apply normally.

## Runtime trajectory, recovery, and Code Mode

LCA records an append-only runtime event stream under its local workspace data directory. `workspace_status action=trace` projects that stream into a correlation-grouped trajectory, and `lca_input` can display the same trace tree. Tool metrics and AgentMemory observations consume the shared action pipeline instead of instrumenting separate execution paths. Optional OTLP/HTTP export is enabled with `OTEL_EXPORTER_OTLP_ENDPOINT`; JSONL remains the local source of truth.

LCA executes coding work directly through its local tool runtime. `workspace_exec action=code` can combine multiple LCA backend actions in one TypeScript worker program; every nested binding still re-enters the ordinary backend pipeline and correctness checks.

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

For the complete release gate:

```bash
cd server
npm ci
npm run test:all
```

For the self-improvement roadmap acceptance bundle only:

```bash
cd server
npm run test:self-improvement
```

Useful focused checks:

```bash
npm run typecheck
npm run test:unit
npm run test:runtime
npm run test:integration:context
npm run test:compact
npm run test:pro
npm run test:trusted-runtime
npm run docs:check
```

The release gate covers TypeScript, mandatory context fan-out, persistent MCP clients, desktop bridges, compact schema budgets, Pro behavior, direct trusted execution, transport hardening, self-improvement invariants, and end-to-end evals.

Historical baseline versus the compact runtime:

| Metric | Before | Current target |
|---|---:|---:|
| Model-facing tools | 143 | 19 |
| `tools/list` bytes | 91,420 | under 24,000 |
| Server instruction chars | 4,458 | under 1,000 |

## License

[AGPL-3.0-or-later](LICENSE) © 2026 Lương Duy.
