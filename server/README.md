# Local Coding Agent MCP server

Local Coding Agent is a trusted local MCP execution engine. ChatGPT sees fourteen compact tools while an internal in-memory backend retains the richer implementation details.

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
workspace_status
workspace_skill
figma
dbeaver
bruno
lca_input
```

Use `workspace_context` first for coding tasks. It always fans out to current filesystem search, CodeGraph, and AgentMemory and returns per-provider coverage. Use `action=discover` on a facade only when its exact backend actions are needed.

Actions execute directly without mode, policy, or approval turns. Project roots support discovery and relative paths; absolute paths are accepted. LCA is not an OS sandbox.

## Terminal UI

```bash
lca-custom tui
```

The mouse-enabled TUI is implemented in `tui.mjs` and `tui/`. It is a persistent Streamable HTTP MCP client of the public fourteen-tool surface, not a direct import of backend handlers. See [`../docs/TUI.md`](../docs/TUI.md).

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

CodeGraph `1.5.0` is pinned in the core server dependency tree. Its MCP stdio connection is lazy, persistent, single-flight, and automatically indexes or synchronizes each project.

AgentMemory `0.9.28` is installed as a separate managed companion runtime under `runtime/agentmemory`. LCA owns health checks, startup, stale-session reconciliation, observations, summaries, decisions, export, and import. The lean default install omits optional ONNX packages and uses local BM25 search without an external LLM key.

Neither dependency is exposed as a separate ChatGPT tool surface. The application layer requires both on every `workspace_context` call.

## MCP integrations

Figma, DBeaver, Bruno, and the remote Coolify MCP use persistent Streamable HTTP clients. Connections and `tools/list` responses are reused, concurrent connects are deduplicated, retryable transport failures reconnect once, and all clients close during graceful server exit. Coolify transport credentials come only from `COOLIFY_MCP_AUTH_TOKEN` and are never returned in status results.

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
| `AGENT_WORKSPACE` | managed config | Primary project for discovery and relative paths. |
| `AGENT_EXTRA_ROOTS_JSON` | `[]` | Additional project roots for cross-project context. |
| `MCP_AUTH_TOKEN` | empty | Optional bearer token for `/mcp`. Header only. |
| `MCP_ALLOWED_ORIGINS` | empty | Browser origins allowed to call `/mcp`; empty denies browser-origin calls. |
| `AGENT_AUDIT` | `1` | Set `0` to disable audit events. |
| `AGENT_AUDIT_ARGS` | `1` | Set `0` to omit summarized arguments from audit events. |
| `AGENT_MAX_BODY_BYTES` | bounded | Maximum request body size. |
| `AGENT_READ_DEFAULT` | `30000` | Default per-file response budget. |
| `AGENT_MAX_BATCH_READ_CHARS` | `500000` | Combined `read_many` budget. |
| `AGENT_CMD_OUTPUT_DEFAULT` | `20000` | Default foreground command output budget. |
| `AGENTMEMORY_URL` | `http://127.0.0.1:3111` | Managed AgentMemory endpoint. |
| `AGENTMEMORY_RECORD_SESSIONS` | `1` | Set `0` for isolated tests or stateless runs. |
| `FIGMA_DESKTOP_MCP_URL` | `http://127.0.0.1:3845/mcp` | Figma Desktop MCP. |
| `DBEAVER_DESKTOP_MCP_URL` | `http://127.0.0.1:3846/mcp` | DBeaver Desktop MCP. |
| `BRUNO_DESKTOP_MCP_URL` | `http://127.0.0.1:3847/mcp` | Bruno Desktop MCP. |

## Tests

```bash
npm run test:all
```

Focused gates include `test:tui`, `test:compact`, `test:integration:context`, `test:persistent-http`, `test:figma`, `test:dbeaver`, `test:bruno`, `test:pro`, `test:trusted-runtime`, `test:hardening`, and `eval`.
