# LCA trusted compact architecture

## Release state

The refactor is complete against the agreed product contract:

- Node.js remains the runtime.
- ChatGPT sees exactly twenty compact tools, including delegated-agent/runtime UI facades plus the `notion` facade and direct `notion_page` app.
- There is no model-facing legacy surface.
- There are no mode, policy, approval, command-denylist, or root-authorization layers.
- Tool actions execute directly as the local user.
- Project roots are discovery and relative-path defaults; absolute paths are accepted.
- Loopback binding, optional bearer auth, browser-origin checks, request/output budgets, timeouts, audit redaction, and process-tree cleanup remain operational safeguards.
- DBeaver, Bruno, and Notion retain their existing integration-specific protection semantics; the trusted-local fast path applies everywhere else.

## Public MCP surface

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
penpot
coolify
notion
lca_input
notion_page
```

The façade contract lives in `server/src/interfaces/mcp/compact-mcp-interface.ts`. The current compatibility backend exposes 185 internal actions behind those twenty compact tools. Every hidden action belongs to exactly one façade, discovery is bounded, and cross-facade dispatch is rejected.

## Mandatory context orchestration

`BuildTaskContext` always starts these providers concurrently:

1. filesystem and ripgrep evidence
2. CodeGraph evidence
3. AgentMemory evidence

A provider may return no matches, but it may not be skipped. Failure of a required provider is explicit. The merger reserves space for every provider that returned evidence, then ranks remaining items with current source code above graph-derived context and memory.

The response includes:

- provider queried status
- hit count
- latency
- CodeGraph index age/status
- bounded evidence and conflict metadata

This prevents the model from “forgetting” CodeGraph or AgentMemory even though neither is exposed as a separate ChatGPT tool.

## CodeGraph

CodeGraph `1.5.0` is pinned in `server/package-lock.json`.

- one lazy persistent stdio MCP client per managed project scope
- concurrent connects deduplicated
- project paths normalized to absolute paths
- automatic init/index/sync
- one reconnect after a retryable transport failure
- bounded graph text mapped into application-layer evidence

Generated `.codegraph` databases are runtime artifacts and are never committed or moved between machines; they are rebuilt from source.

## AgentMemory

AgentMemory `0.9.28` is isolated in `runtime/agentmemory` instead of sharing the core server dependency tree.

- separate exact lockfile and `.npmrc`
- optional ONNX/local embedding packages omitted by default
- approximately 113 MB lean installation in the measured Linux environment
- local BM25 search works without an external LLM key
- managed health, startup, retry, and orphan-engine recovery
- project/process-scoped sessions
- non-blocking serialized observation queue
- compact safe metadata only; raw commands and file contents are not stored in observations
- stale sessions reconciled after crashes
- graceful close flushes summary and completes the session before stopping the managed worker
- explicit `workspace_edit action=decision` writes both the project decision log and an immediate AgentMemory fact

### Portable backups

`lca-custom memory export` and `memory import` use the official AgentMemory API through a versioned envelope with canonical SHA-256 checksums. Files are atomic and private (`0600`). Dry-run validation is offline. Real imports create a pre-import backup. `skip` is the default idempotent strategy; `replace` requires `--force`.

## Persistent desktop bridges

`server/persistent-http-mcp-client.mjs` is shared by Figma, DBeaver, Bruno, and Penpot. Coolify uses a persistent local stdio client. Notion is stateless REST and keeps its bearer token only in local process configuration; its Apps SDK widget calls the compact `notion` facade rather than the API directly.

- registry key includes endpoint, client name, timeout, and a hash of credentials
- connection setup is single-flight
- `tools/list` is cached and refreshed when a requested tool is missing
- retryable transport errors reconnect once
- ordinary tool errors do not reconnect
- credentials are never included in logs or results
- registries close during graceful server exit

### DBeaver invariant

`dbeaver_propose_sql` returns a model-visible artifact and a widget-only run capability in `_meta`. The capability is absent from model-visible content. Preparation and execution require this capability, use the immutable SQL/connection captured at proposal time, and still require DBeaver’s native confirmation. Generic passthrough accepts only upstream tools declaring `readOnlyHint=true`.

## Runtime event spine and agent durability

All backend actions execute through `ActionExecutionPipeline`. The pipeline emits typed events into an append-only JSONL `RuntimeEventStore`; it does not reintroduce permission or approval checks. `tool/started` is enqueued without delaying action start, while completion/failure remains a durability barrier that preserves ordering.

The runtime event stream drives multiple projections:

- ToolMetrics latency and payload-size metadata
- AgentMemory observations for model-facing calls
- `workspace_status action=trace` correlation-grouped trajectory
- the trace tree in `lca_input`
- optional metadata-only OTLP/HTTP export when `OTEL_EXPORTER_OTLP_ENDPOINT` is configured

`AgentRunnerRegistry` persists job and DAG snapshots into the same event stream. A restart reconstructs durable descriptors; jobs that had already finalized an isolated worktree patch become `recoverable`, while interrupted active work without a recoverable patch is reported as `orphaned`. Resume/follow-up/interrupt are optional runner capabilities rather than fake universal behavior.

Codex workers default to `danger-full-access`, network enabled, and isolated Git worktrees. File scopes are optional correctness assertions for isolated workers; shared parallel writers still need disjoint scopes unless overlap is explicitly allowed. Merge remains explicit and conflict-checked.

## Code Mode and conversation runtime composition

`workspace_exec action=code` runs a TypeScript program in a fresh bounded worker and exposes curated `lca.search/read/edit/exec/git/verify/status/agent/ui` bindings. Every binding resolves back to the existing hidden backend action and therefore re-enters normal tracing, metrics, correctness checks, and integration behavior. Recursive Code Mode calls are rejected.

`ConversationRuntimeContext` extends the old project-only scope with conversation/session identity, runner/profile, worktree/shared isolation, network defaults, and correlation state while keeping project roots as discovery inputs rather than authorization boundaries. `RuntimePluginHost` provides a small reversible lifecycle abstraction with reverse-order disposal; LCA does not embed Cordis.

Generated contracts under `docs/generated/` are produced from source and checked in CI: tool catalog, action catalog, runtime event catalog, provider capabilities, and runtime graph. JSONL remains the local source of truth even when OTLP export is enabled.

## Managed installer and doctor

`scripts/managed-runtime.mjs` owns machine portability:

- exact `npm ci` for core and AgentMemory runtimes
- deterministic TypeScript build before fingerprinting or process reuse
- fingerprint across manifests, lockfiles, build inputs, and runtime npm policy
- atomic managed-runtime stamp
- repair only missing or stale layers
- stop-before-replace for Windows file locking
- server restart only when the runtime fingerprint changes
- tunnel singleton reuse
- machine-readable `install --json` and `doctor --json`
- Docker/iii-engine strategy and service health receipt

Old config fields named `mode`, `policy`, and `surface` are removed during normalization and are never sent to the server.

## Clean architecture boundary

```text
interfaces/mcp
      ↓
application/context and use cases
      ↓
ports
      ↓
adapters/filesystem, codegraph, agentmemory
      ↓
infrastructure/process and persistent MCP clients
```

MCP handlers validate and present. They do not own context ranking, dependency lifecycle, memory semantics, or desktop transport state.

## Measurements

Historical baseline from commit `944dcc6` is frozen in `evals/baseline.json`:

- 143 model-facing tools
- 91,420 bytes of tool schema
- 4,458 instruction characters
- 14.13 ms median local `tools/list`

The current compact-surface gate reports:

- 20 model-facing tools, down about 86% from the 143-tool historical baseline
- 18,781 bytes of compact schema, under the 20 KB release budget
- complete compact-facade coverage of 185 internal backend actions

The Phase 8 runtime benchmark reports a representative local run of roughly 0.2 ms average action-pipeline overhead, effectively zero measured p95 delay before action-body start, sub-microsecond conversation-context scope overhead, and Code Mode latency improvement well above the 15% ship threshold on independent-read workloads. Exact measurements are intentionally rerunnable with `npm run benchmark:runtime` and `npm run benchmark:code-mode` rather than frozen as universal hardware claims.

## Release gates

`npm run test:all` verifies:

- TypeScript typecheck and unit tests
- live CodeGraph context integration
- mandatory filesystem, CodeGraph, and AgentMemory fan-out
- provider quota and conflict behavior
- AgentMemory lifecycle, decisions, and supervisor recovery
- persistent HTTP MCP connection semantics
- Figma, DBeaver, Bruno, Penpot, Coolify, and Notion contracts
- twenty-tool schema and complete internal action coverage
- runtime event ordering, durable agent restart reconstruction, trajectory, Code Mode, and reversible runtime composition
- generated architecture contract drift and optional metadata-only OTLP export
- direct absolute-path, command, Git, delete, and desktop execution
- auth header handling, origin rejection, body caps, audit redaction, undo isolation, and process cleanup
- Pro snapshot, widget resources, project search, manual verification, and review flows
- end-to-end eval scenarios

## Definition of done

The release is complete when the full gate passes, the benchmark meets all budgets, `lca-custom doctor --json` is healthy, the live server reports `trusted-local` and `compact`, `workspace_context` returns coverage from all three providers, the active tunnel is reused, and the Git working tree is clean after the release commit.
