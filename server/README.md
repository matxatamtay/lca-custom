# Local Coding Agent MCP server

Local Coding Agent is a trusted local MCP execution engine. ChatGPT sees fifteen compact tools while an internal in-memory backend retains the richer implementation details.

## Public MCP tools

```text
workspace_context
workspace_search
workspace_read
workspace_edit
workspace_exec
workspace_process
workspace_git
workspace_verify
workspace_agent
workspace_ui
workspace_status
workspace_skill
figma
dbeaver
bruno
coolify
lca_input
notion_page
```

Use `workspace_context` first for coding tasks. It always fans out to current filesystem search, native semantic analysis, CodeGraph, and AgentMemory and returns per-provider coverage. The default context pack is intentionally compact (10 items / ~12k chars), includes bounded source slices plus `execution_hints.likely_reads`, and can attach a cached changed-file verification hint. Use `action=discover` on a facade only when its exact backend actions are needed.

Actions execute directly without mode, policy, or approval turns. Project roots support discovery and relative paths; absolute paths are accepted. LCA is not an OS sandbox.


`lca_input` can select a conversation-scoped primary project. The widget persists that selection for its rendered chat UI, and compact tools accept a top-level `project` envelope field. Scoped calls resolve relative paths and default discovery from that folder while explicit absolute paths can still reach another configured project. Omitting `project` preserves the existing multi-root behavior and never changes the daemon/TUI global primary root.

## Terminal UI

```bash
lca-custom tui
```

The mouse-enabled TUI is implemented in `tui.mjs` and `tui/`. It is a persistent Streamable HTTP MCP client of the public fifteen-tool surface, not a direct import of backend handlers. See [`../docs/TUI.md`](../docs/TUI.md).

## Run

The managed CLI is the supported entrypoint:

```bash
lca-custom install
lca-custom start --background
lca-custom doctor
```

Low-level development run:

```bash
cd server
npm ci
npm start
```

- MCP: `http://127.0.0.1:8790/mcp`
- Health: `http://127.0.0.1:8790/healthz`

## Code intelligence and memory

TypeScript/JavaScript semantic context uses a persistent TypeScript 7 native API/tsgo session. Dart/Flutter uses a persistent Dart Analysis Server LSP session discovered from the project FVM/Dart SDK. Java uses persistent Eclipse JDT LS with per-project workspace data under `server/data/semantic/jdtls`; the pinned isolated runtime is provisioned with `node ../scripts/jdtls-runtime.mjs install`. Dart and Java cold indexing happens in the background and reports `warming` until exact-symbol evidence can be served safely.

CodeGraph `1.5.0` is pinned in the core server dependency tree. Its MCP stdio connection is lazy and persistent, with internal narrow search/callers/callees/impact tools enabled behind the LCA adapter. Normal symbol tasks avoid source-heavy exploration. Cold structural/architecture tasks use staged escalation (`search` -> `callers`/`impact` -> `explore`) so deep exploration only runs when cheaper relationship queries are insufficient; verbatim deep source dumps are stripped from the compact context pack. Evidence is cached by graph revision and invalidated by real changed-file metadata changes. Filesystem and semantic context also use revision-aware hot caches; post-edit processing invalidates affected state and prewarms CodeGraph/semantic work for the next call. Startup also prewarms up to three recent configured workspaces in the background without blocking MCP availability.

AgentMemory `0.9.28` is installed as a separate managed companion runtime under `runtime/agentmemory`. LCA owns health checks, startup, stale-session reconciliation, observations, summaries, decisions, export, and import. First-session bootstrap overlaps project-scoped recall instead of serializing it, and exact repeated recalls use a short bounded cache with mutation invalidation. The lean default install omits optional ONNX packages and uses local BM25 search without an external LLM key.

Change-aware verification caches impacted-test topology by changed-file and manifest fingerprints. Independent uncached gates can execute concurrently with bounded concurrency, while successful cache writes remain serialized. `workspace_edit` / `apply_patch` remains edit-only by default; callers can opt into `verify: "changed"` to run the cheapest safe changed-file gates in the same model round-trip. Related edits should be batched with `workspace_edit action=batch` / `apply_patch`; `replace_in_file` also supports an ordered `replacements[]` batch for one-file changes.

Model-facing task telemetry is persisted per workspace under `server/data/workspaces/<id>/performance-telemetry.json` and exposed by `workspace_info`, including context/provider latency, round trips, bytes returned to the model, read/edit/verification time, and cache-hit ratios. Telemetry v2 labels user/internal/synthetic workloads, tracks cold/mixed/warm context, reports p50/p95, and age-weights recent user work so benchmarks and LCA self-maintenance do not distort autotuning. `workspace_context` uses that cleaned workspace-scoped history only for bounded recommendations: an adaptive workflow hint selects a short fast/inspect/review path, and conservative autotuning may adjust omitted context budgets between compact (`8/~9k`), baseline (`10/~12k`), or expanded (`12/~15k`) profiles. Explicit caller budgets always override autotuning and all four context providers remain mandatory.

Foreground execution has a conservative toolchain accelerator. Only allowlisted analysis-only commands such as TypeScript typecheck, `flutter analyze`, `dart analyze`, mypy, and pyright can reuse a prior successful result, and only for an identical Git HEAD + dirty/untracked-content revision. Tests, builds, lint scripts, and arbitrary shell commands always execute. Install/setup commands are never persistently cached and are only deduplicated while an identical call is concurrently in flight. `workspace_exec many` also supports bounded dependency DAGs via `id` + `depends_on`, allowing independent checks to run concurrently without starting dependent work early.

A second long-lived performance-follow log is stored at `server/data/workspaces/<id>/performance-follow.json`. It retains a bounded history of timing samples for tools, context providers, and sanitized command families, with p50/p95, total wall-clock bottlenecks, cache efficiency, task classes, and cold/warm context rollups. It intentionally does not persist raw task text, command strings, arguments, patches, stdout/stderr, or secrets. Query it through `workspace_status action=performance` with optional `path`, `window_days`, `task_class`, and `compact` arguments; `workspace_info` also includes a compact 30-day user-work summary.

None of these context engines is exposed as a separate ChatGPT tool surface. The application layer keeps CodeGraph and AgentMemory mandatory while semantic capability is reported explicitly when unavailable.

## MCP integrations

Figma, DBeaver, Bruno, and Penpot use persistent MCP clients. Coolify runs the pinned `@masonator/coolify-mcp` package as a persistent local stdio child process. Notion uses the official REST API through `NOTION_API_KEY` and exposes both the compact `notion` facade and the direct `notion_page` Apps SDK widget. Penpot and Coolify execute directly in trusted-local mode; DBeaver, Bruno, and Notion preserve their integration-specific protection semantics. Notion full-page Markdown replacement keeps optimistic conflict detection and child-content deletion disabled unless explicitly requested.

## Runtime trajectory and delegated agents

Every backend action runs through `ActionExecutionPipeline`. The append-only runtime source of truth is `data/workspaces/<id>/runtime/events.jsonl`; ToolMetrics, AgentMemory observations, the `workspace_status action=trace` trajectory, and optional OTLP export are consumers of that event stream. Delegated Codex work defaults to `danger-full-access` with network access enabled inside isolated Git worktrees, while merge remains conflict-checked. Agent/DAG descriptors are persisted so a restart reconstructs completed, recoverable, or orphaned work instead of losing lifecycle state.

`workspace_exec action=code` runs a TypeScript orchestration program in a fresh bounded worker. Its curated LCA bindings re-enter the ordinary hidden backend pipeline, so nested reads, edits, commands, verification, agents, and UI actions keep normal tracing and correctness checks.

### DBeaver SQL flow

DBeaver remains editor-first:

1. Propose visible SQL with `dbeaver_propose_sql`.
2. Stop and let the user press **Run** in the SQL Artifact.
3. The widget receives a hidden short-lived capability unavailable in model-visible content.
4. LCA prepares the exact immutable proposal and DBeaver shows its native confirmation.
5. After confirmation, the widget executes using the one-time native approval plus the hidden capability.

Direct model-style preparation or execution without the widget capability is rejected. Generic `dbeaver_call_tool` remains limited to upstream tools declaring `readOnlyHint=true`.

## Important environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `8790` | Local MCP HTTP port. |
| `AGENT_HOST` | `127.0.0.1` | Bind address. Keep loopback for normal use. |
| `AGENT_WORKSPACE` | managed config | Default project when a tool omits its target; configured roots otherwise participate as peer workspaces. |
| `AGENT_EXTRA_ROOTS_JSON` | `[]` | Additional peer project roots for cross-project read/edit/exec/context routing. |
| `MCP_AUTH_TOKEN` | empty | Optional bearer token for `/mcp`. Header only. |
| `MCP_ALLOWED_ORIGINS` | empty | Browser origins allowed to call `/mcp`; empty denies browser-origin calls. |
| `AGENT_AUDIT` | `1` | Set `0` to disable audit events. |
| `AGENT_AUDIT_ARGS` | `1` | Set `0` to omit summarized arguments from audit events. |
| `AGENT_MAX_BODY_BYTES` | bounded | Maximum request body size. |
| `AGENT_READ_DEFAULT` | `30000` | Default per-file response budget. |
| `AGENT_MAX_BATCH_READ_CHARS` | `500000` | Combined `read_many` budget. |
| `AGENT_CMD_OUTPUT_DEFAULT` | `20000` | Default foreground command output budget. |
| `AGENT_MEMORY_VAULT` | platform data directory | Obsidian-compatible persistent vault containing global, project, and task notes. |
| `AGENTMEMORY_URL` | `http://127.0.0.1:3111` | Managed AgentMemory endpoint. |
| `AGENTMEMORY_RECORD_SESSIONS` | `1` | Set `0` for isolated tests or stateless runs. |
| `FIGMA_DESKTOP_MCP_URL` | `http://127.0.0.1:3845/mcp` | Figma Desktop MCP. |
| `DBEAVER_DESKTOP_MCP_URL` | `http://127.0.0.1:3846/mcp` | DBeaver Desktop MCP. |
| `BRUNO_DESKTOP_MCP_URL` | `http://127.0.0.1:3847/mcp` | Bruno Desktop MCP. |
| `PENPOT_MCP_URL` | `http://127.0.0.1:9001/mcp/stream` | Local Penpot MCP endpoint without credentials. |
| `PENPOT_USER_TOKEN` | empty | Generated Penpot MCP user token; store only in `.env.local`. |
| `PENPOT_MCP_TIMEOUT_MS` | `120000` | Penpot tool timeout. |

## Tests

```bash
npm run test:all
```

Focused gates include `test:protocol`, `test:tui`, `test:compact`, `test:integration:context`, `test:persistent-http`, `test:figma`, `test:dbeaver`, `test:bruno`, `test:penpot`, `test:coolify`, `test:notion`, `test:notion:widget`, `test:pro`, `test:trusted-runtime`, `test:hardening`, and `eval`.
