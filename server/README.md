# Local Coding Agent — MCP server

A local MCP server that ChatGPT Web (or any MCP client) connects to as a tool.
It lets the model act like a coding agent on **your own machine** — read/write
files, run commands, manage background processes, and use git — confined to
folders you configure. It does **not** use an API key and does **not** automate
ChatGPT sessions; it is a normal MCP connector you authorize.

> Full documentation, security model, and setup: see the [repository README](../README.md).

## Tools

| Group | Tools |
|-------|-------|
| Info | `workspace_info`, `ping` |
| Read | `repo_overview`, `list_files`, `find_files`, `read_file`, `read_many` (concurrent + line ranges), `stat_path`, `search_text` (ripgrep/git, with context + glob), `workspace_search` (multi-project `@` autocomplete) |
| Figma Desktop | `figma_status`, `figma_list_tools`, `figma_call_tool`, `figma_get_design_context`, `figma_get_screenshot`, `figma_get_metadata`, `figma_get_variable_defs`, `figma_get_code_connect_map`, `figma_get_figjam` |
| DBeaver Desktop | status/discovery, SQL editor UI tools, `dbeaver_propose_sql`, native-confirmed `dbeaver_prepare_sql_execution` + `dbeaver_execute_sql`, paged results, and editor-scoped transactions |
| Write | `write_file`, `replace_in_file`, `apply_patch`, `make_dir`, `move_path`, `delete_path` |
| Execute | `run_command`, `run_commands` (bounded batch; cmd/powershell/bash/sh/zsh) |
| Processes | `proc_start`, `proc_list`, `proc_output`, `proc_stop` |
| Git | `git` |
| Pro | `workspace_snapshot`, `workspace_doctor`, `repo_map`, `repo_symbols`, `review_diff`, `session_report` |
| Manual verification | `detect_test_commands`, `quality_gate`, `run_tests`, `run_build`, `run_lint`, `run_changed_tests` |
| Notes & session | `save_note`, `list_notes`, `checkpoint`, `resume` |

## Run

Recommended flow from any project repo:

```bash
cd /path/to/your/repo
lca-custom
```

Low-level server-only run:

```bash
cd server
npm install
# minimum: point it at a folder you want the agent to work in
#   Windows PowerShell:  $env:AGENT_WORKSPACE="<path-to-your-repo>"
#   bash:                export AGENT_WORKSPACE="/path/to/your/repo"
npm start
```

- MCP endpoint: `http://127.0.0.1:8790/mcp`
- Health: `http://127.0.0.1:8790/healthz`

## DBeaver operator flow

The DBeaver bridge is editor-first rather than a hidden SQL executor:

1. Use `dbeaver_open_sql_editor` or `dbeaver_propose_sql` so the user can see the SQL in DBeaver. `dbeaver_propose_sql` renders an interactive SQL Artifact with **Open in DBeaver**, **Run**, **Explain**, and **Save Snippet** actions.
2. After `dbeaver_propose_sql` returns, the model must stop. No native dialog is allowed yet.
3. The user clicks **Run** in the SQL Artifact. The widget receives a short-lived capability through tool-result `_meta`; this value is not included in model-visible content.
4. Only the widget can call `dbeaver_prepare_sql_execution` with that capability. LCA supplies the immutable SQL and connection captured at proposal time, so cursor movement, selection loss, or later editor focus cannot change what runs. DBeaver then displays the native dialog with the exact connection, SQL, source, and read/write risk.
5. When the user approves, the widget receives a one-time `approval_id` and immediately calls `dbeaver_execute_sql` with both the native approval and its hidden capability.
6. Read the preview with `dbeaver_get_last_result`, then use `dbeaver_fetch_result` for bounded pages.

`dbeaver_prepare_sql_execution` and `dbeaver_execute_sql` are declared app-only and also enforce the hidden capability server-side. A model or non-widget client cannot trigger a native SQL dialog or execution by calling them directly. `dbeaver_call_tool` remains limited to upstream tools declaring `readOnlyHint=true`, so it cannot bypass the execution gate. Under `AGENT_POLICY=strict`, operator execution and transaction mutation tools are blocked, while read-only discovery remains available.

## Configuration (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `8790` | HTTP port for the MCP endpoint. |
| `AGENT_HOST` | `127.0.0.1` | Bind address. Keep loopback; the tunnel forwards to it. |
| `AGENT_WORKSPACE` | `../agent-workspace` | Primary root the agent may touch. |
| `AGENT_EXTRA_ROOTS` | _(empty)_ | Extra roots, `;`-separated. |
| `AGENT_EXTRA_ROOTS_JSON` | _(empty)_ | Extra roots as a JSON string array. Prefer this for paths that contain separators. |
| `AGENT_MODE` | `safe` | Command guardrail. `safe` = conservative blocklist; `full` = fewer app-level command blocks. Not an OS sandbox. |
| `AGENT_POLICY` | `balanced` | Tool policy. `strict` = read-only; `balanced` = local approval for risky actions; `full` = no policy approval gate. |
| `AGENT_ALLOW_DANGEROUS` | _(unset)_ | `1` allows even catastrophic system commands. Leave unset. |
| `MCP_AUTH_TOKEN` | _(empty)_ | If set, every `/mcp` request must send `Authorization: Bearer <token>`. |
| `MCP_ALLOWED_ORIGINS` | _(empty)_ | Trusted browser origins for `/mcp`. Empty rejects browser-origin MCP calls. |
| `AGENT_APPROVAL_TOKEN` | _(empty)_ | Secret for token-based approval tools. In `policy=balanced`, set this to approve risky actions without switching to `policy=full`. |
| `AGENT_APPROVAL_TTL_MINUTES` | `10` | Exact approval expiry, clamped to 1-30 minutes. |
| `AGENT_AUDIT` | `1` | Set `0` to disable audit logging for maximum hot-path speed. |
| `AGENT_AUDIT_ARGS` | `1` | Set `0` to keep audit events but skip argument serialization/redaction. |
| `AGENT_HTTP_LOG` | `0` | Set `1` to print every HTTP request. Disabled by default to keep tunnel traffic quiet. |
| `AGENT_MAX_BATCH_READ_CHARS` | `500000` | Combined text cap for one `read_many` response. |
| `AGENT_READ_DEFAULT` | `30000` | Default chars `read_file` returns (raise per-call via `max_chars`). Keeps payloads + context small. |
| `AGENT_CMD_OUTPUT_DEFAULT` | `20000` | Default chars of command output returned (use `tail_lines`/`head_lines`/`max_output_chars`). |
| `FIGMA_DESKTOP_MCP_URL` | `http://127.0.0.1:3845/mcp` | Official local MCP endpoint exposed by Figma Desktop after enabling it in Dev Mode. |
| `FIGMA_DESKTOP_TIMEOUT_MS` | `30000` | Timeout for connecting to or calling the Figma Desktop MCP server. |
| `FIGMA_DESKTOP_ALLOW_REMOTE` | `0` | Set `1` only to allow a non-loopback override. The official desktop endpoint is loopback. |
| `DBEAVER_DESKTOP_MCP_URL` | `http://127.0.0.1:3846/mcp` | MCP endpoint exposed by the patched DBeaver Desktop build. |
| `DBEAVER_DESKTOP_TIMEOUT_MS` | `45000` | Timeout for connecting to or calling DBeaver Desktop MCP. |
| `DBEAVER_DESKTOP_AUTH_TOKEN` | _(empty)_ | Bearer token matching DBeaver's `DBEAVER_MCP_AUTH_TOKEN`, when enabled. |
| `DBEAVER_RUN_INTENT_TTL_MS` | `600000` | Lifetime of the widget-only SQL Run capability, clamped to 1-30 minutes. |
| `DBEAVER_DESKTOP_ALLOW_REMOTE` | `0` | Set `1` only to allow a non-loopback DBeaver endpoint. |

`ripgrep` (`rg`) is auto-installed by `lca-custom setup` when a supported package
manager is available. It is not required, but `search_text`, `find_files`, and
repo mapping are much faster with it.

Fast workflow note: test/build/lint tools are kept for explicit manual use, but
`workspace_snapshot` and default guidance do not recommend running them
automatically.

## Test

```bash
npm run test:agent       # exercises every tool against a running server
npm run test:security    # runtime security checks against a running server
npm run test:hardening   # self-contained policy/origin/body/undo regressions
npm run test:pro         # Pro snapshot/report/tier regression checks
npm run test:figma       # mocked Figma Desktop MCP bridge checks
npm run test:dbeaver     # mocked DBeaver Desktop MCP bridge and policy checks
```
# Bruno Desktop bridge

Local Coding Agent can connect to the Bruno Automation Platform MCP server running inside Bruno Desktop.

```env
BRUNO_DESKTOP_MCP_URL=http://127.0.0.1:3847/mcp
BRUNO_DESKTOP_AUTH_TOKEN=<token copied from Bruno Preferences>
BRUNO_DESKTOP_TIMEOUT_MS=120000
BRUNO_DESKTOP_ALLOW_REMOTE=0
```

Enable MCP in Bruno Preferences, allowlist the required workspace and network hosts, then choose the smallest permission profile that fits the task. The bridge rejects non-loopback endpoints unless `BRUNO_DESKTOP_ALLOW_REMOTE=1` is explicitly set.

Dedicated tools cover request and flow reads, preparation, execution, cancellation, and revision-safe flow patches. `bruno_call_tool` forwards only upstream tools annotated with `readOnlyHint=true` and `destructiveHint=false`, so it cannot be used to bypass execution or mutation policy.

Flow edits require two steps:

1. Call `bruno_preview_flow_patch` with `expected_revision` and operations.
2. Review the preview, then call `bruno_apply_flow_patch` with explicit approval and the short-lived patch intent returned in `_meta`.

Run the bridge integration gate with:

```bash
npm run test:bruno
```
