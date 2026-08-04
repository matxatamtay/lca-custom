# AGENTS.md

## Product contract

Local Coding Agent is a trusted local MCP execution engine for ChatGPT. The model-facing surface is always the compact sixteen-tool facade. The complete implementation remains behind an internal in-memory backend and must never be exposed as a second public legacy surface.

`workspace_context` is the default first call for coding tasks. It must always query filesystem search, CodeGraph, and AgentMemory in parallel, then return a coverage receipt. A provider may return zero hits, but it must not be silently skipped.

Project roots are discovery and relative-path defaults, not authorization boundaries. Absolute paths and direct file, command, process, Git, Bruno, and Figma operations are supported without policy or approval round-trips.

DBeaver is the intentional exception to fully model-triggered execution: SQL is editor-first. After `dbeaver_propose_sql`, stop and let the user press **Run** in the SQL Artifact. Only the widget receives the hidden capability that can call preparation and execution for the exact proposed SQL.

## Prerequisites

- Node.js 20 or newer
- npm
- Git
- Docker for the default managed AgentMemory engine
- OpenAI tunnel ID and runtime API key for ChatGPT Web

Never commit secrets, `.env.local`, generated profiles, `tools/`, `.agent/state/`, `server/data/`, `server/dist/`, `node_modules/`, runtime databases, backups, or logs.

## Setup

```bash
# macOS, Linux, WSL
bash scripts/lca-custom setup
```

```powershell
# Windows
scripts\lca-custom.cmd setup
```

The installer pins and verifies the core server, CodeGraph, AgentMemory, TypeScript build, tunnel binary, local configuration, and service state. Verify a machine with:

```bash
lca-custom doctor
lca-custom status
```

## Daily commands

```bash
lca-custom reset /path/to/main-project
lca-custom add /path/to/another-project
lca-custom start --background
lca-custom stop
lca-custom doctor --fix
lca-custom memory export
```

Adding, removing, or resetting projects restarts the managed server when necessary. The configured roots help context discovery across projects; they do not limit absolute tool paths.

## ChatGPT custom app

Create a custom MCP app in Developer mode, select the private tunnel, and use `No auth` unless local bearer authentication is intentionally configured. Refresh the app after changing the public tool schema.

Local endpoints:

- MCP: `http://127.0.0.1:8790/mcp`
- Health: `http://127.0.0.1:8790/healthz`

## Validation

Run the complete release gate from `server/`:

```bash
npm run test:all
```

The gate covers TypeScript, mandatory dual-source context, persistent MCP clients, all three desktop bridges, compact surface and schema budgets, Pro behavior, trusted-runtime semantics, transport hardening, and end-to-end evals.
