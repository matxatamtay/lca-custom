<div align="center">

<img src="docs/banner.svg" alt="Local Coding Agent" width="760" />

# Local Coding Agent

Trusted local MCP execution engine for ChatGPT with native semantic analysis, CodeGraph, and AgentMemory context.

</div>

> LCA can read and write files, run commands, manage processes, use Git, and call local desktop integrations with your OS user permissions. It is not an OS sandbox. Connect only trusted projects and clients. See [SECURITY.md](SECURITY.md).

## What ships

ChatGPT sees exactly fifteen tools:

```text
workspace_context  workspace_search  workspace_read   workspace_edit
workspace_exec     workspace_process workspace_git    workspace_verify
workspace_status   workspace_skill   figma            dbeaver
bruno              coolify           lca_input
```

`workspace_context` is the default first call for coding tasks. Every call queries four context lanes in parallel:

1. current files and ripgrep search
2. language-native semantic analysis for exact symbols and references
3. CodeGraph structure and impact context
4. AgentMemory project history and decisions

The response includes a coverage receipt for all four lanes. CodeGraph and AgentMemory remain required; semantic analysis reports `unavailable` explicitly when a language backend is not ready.

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

The model-facing MCP server dispatches into an internal in-memory backend containing 144 implementation actions. This preserves precise handlers and compatibility while keeping the tool schema small. Cross-facade dispatch is rejected.

Language-native semantic analysis runs in parallel with CodeGraph. TypeScript/JavaScript uses a persistent TypeScript 7 native API/tsgo session. Dart/Flutter uses the project Dart Analysis Server over persistent LSP with background cold prewarming, so the first context call reports `warming` instead of blocking. Java uses a persistent Eclipse JDT LS session with project-isolated workspace metadata; the checksum-pinned JDT runtime lives under ignored `runtime/jdtls/` and can be provisioned with `node scripts/jdtls-runtime.mjs install`. All three return compact definition/reference locations instead of duplicating source bodies.

CodeGraph remains required but is routed by intent: ordinary symbol tasks use location-only graph search, callers/callees and refactors use narrow relationship tools, and full source-bearing exploration is reserved for architecture/flow work. Results are cached by project + graph revision + normalized query, while changed files force graph refresh/invalidation. AgentMemory remains the separately pinned companion service with managed health, lifecycle, observations, decisions, export, and import.

Figma Desktop, Figma Remote, DBeaver, Bruno, and the remote Coolify MCP use persistent Streamable HTTP connections with cached `tools/list` and graceful close. Figma Remote adds OAuth PKCE with local `0600` token storage and a fail-closed write guard.

More detail and benchmark history: [docs/NEXT_ARCHITECTURE.md](docs/NEXT_ARCHITECTURE.md).

## Desktop integrations

### Figma

LCA supports both official Figma MCP transports through the single `figma` facade:

- Remote, preferred: `https://mcp.figma.com/mcp`, OAuth PKCE, link-based reads, and guarded write-to-canvas tools such as `use_figma`.
- Desktop fallback: `http://127.0.0.1:3845/mcp`, using the current Figma Desktop selection in Dev Mode.

Enable Remote in `.env.local` with `FIGMA_REMOTE_ENABLED=1`. Canvas writes remain blocked unless `FIGMA_REMOTE_ALLOW_WRITE=1`. Start authorization with the `figma` facade action `auth`, open the returned URL, and let Figma redirect to LCA's loopback callback. OAuth tokens and PKCE state are stored outside the repository with file mode `0600`.

Figma currently limits its hosted MCP endpoint to clients in the Figma MCP Catalog. The bridge reports that restriction plainly if Figma rejects LCA's client registration; it never impersonates another supported client.

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
| Model-facing tools | 143 | 14 |
| `tools/list` bytes | 91,420 | under 20,000 |
| Server instruction chars | 4,458 | under 1,000 |

## License

[AGPL-3.0-or-later](LICENSE) © 2026 Lương Duy.
