# LCA trusted compact architecture

## Release state

The refactor is complete against the agreed product contract:

- Node.js remains the runtime.
- ChatGPT sees exactly nineteen compact tools.
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

The façade contract lives in `server/src/interfaces/mcp/compact-mcp-interface.ts`. A singleton in-memory backend retains the richer internal actions. Every hidden action belongs to exactly one façade, discovery is bounded, and cross-facade dispatch is rejected.

## Mandatory context orchestration

`BuildTaskContext` always starts these providers concurrently:

1. filesystem and ripgrep evidence
2. language-native semantic evidence
3. CodeGraph evidence
4. AgentMemory evidence

CodeGraph and AgentMemory remain required providers. Semantic analysis is supplemental but explicit: unsupported or unavailable language engines appear as `status=unavailable` instead of silently disappearing. The merger reserves space for every provider that returned evidence, then ranks remaining items with current source code first, native semantic relationships next, CodeGraph relationships after that, and memory last.

The response includes:

- provider queried status
- semantic language/engine capability and availability
- hit count
- latency
- CodeGraph index age/status
- bounded evidence and conflict metadata

This prevents the model from “forgetting” CodeGraph or AgentMemory even though neither is exposed as a separate ChatGPT tool.

## Native semantic context

Semantic analysis complements CodeGraph rather than replacing it. The application consumes one normalized semantic port while language-specific engines stay behind adapters.

- TypeScript/JavaScript: persistent TypeScript 7 native API/tsgo session, exact symbol definitions and references, incremental `created`/`changed`/`deleted` refresh from `changed_files`, bounded location-only evidence
- Dart/Flutter: persistent Dart Analysis Server LSP session discovered from the project FVM SDK or Dart environment; cold analysis and the first workspace-symbol index warm in the background, coverage reports `warming`, and ready queries reuse compact exact-symbol definition/reference evidence
- Java: persistent Eclipse JDT LS session backed by the isolated pinned runtime under `runtime/jdtls`; each project gets private JDT workspace data under `server/data/semantic/jdtls`, cold Maven import/index work stays in the background, and no Java evidence is returned before JDT is actually ready
- no semantic backend fabricates evidence; missing runtimes report `unavailable`, cold analyzers report `warming`, and CodeGraph still runs in parallel

## CodeGraph

CodeGraph `1.5.0` is pinned in `server/package-lock.json`.

- one lazy persistent stdio MCP client with on-demand per-project CodeGraph handles
- concurrent connects deduplicated
- project paths normalized to absolute paths
- automatic init/index/sync with changed-file hints forcing refresh
- internal narrow tools are enabled without expanding the public nineteen-tool LCA surface: normal symbol tasks use location-only search, callers/callees and refactors use graph-specific queries, and full `explore` is reserved for architecture/flow work
- graph-query evidence is cached by project + CodeGraph database revision + normalized tool arguments; changed files or revision changes invalidate the cache
- CodeGraph provider output is independently bounded so it complements current filesystem source instead of duplicating large source bodies on ordinary tasks
- one reconnect after a retryable transport failure

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

## Runtime event spine

All backend actions execute through `ActionExecutionPipeline`. The pipeline emits typed events into an append-only JSONL `RuntimeEventStore`; it does not reintroduce permission or approval checks. `tool/started` is enqueued without delaying action start, while completion/failure remains a durability barrier that preserves ordering.

The runtime event stream drives multiple projections:

- ToolMetrics latency and payload-size metadata
- AgentMemory observations for model-facing calls
- `workspace_status action=trace` correlation-grouped trajectory
- the trace tree in `lca_input`
- optional metadata-only OTLP/HTTP export when `OTEL_EXPORTER_OTLP_ENDPOINT` is configured

## Code Mode and conversation runtime composition

`workspace_exec action=code` runs a TypeScript program in a fresh bounded worker and exposes curated `lca.search/read/edit/exec/git/verify/status/ui` bindings. Every binding resolves back to the existing hidden backend action and therefore re-enters normal tracing, metrics, correctness checks, and integration behavior. Recursive Code Mode calls are rejected.

`ConversationRuntimeContext` extends the old project-only scope with conversation/session identity, profile, and correlation state while keeping project roots as discovery inputs rather than authorization boundaries. `RuntimePluginHost` provides a small reversible lifecycle abstraction with reverse-order disposal; LCA does not embed Cordis.

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
adapters/filesystem, semantic, codegraph, agentmemory
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

The compact benchmark is generated by `npm run benchmark:compact` and written to `evals/compact.json`. The current macOS arm64 measurement is:

- 19 model-facing tools
- 10,811 bytes of `tools/list`, down 88.17%
- 815 instruction characters, down 81.72%
- 3.73 ms median local `tools/list`
- 3.27 ms median warm `workspace_status`
- 3.27 ms median warm `workspace_read`
- complete coverage of 144 internal backend actions

Phase 3 local real-repository probes on the same machine establish the semantic/graph performance envelope rather than a cross-machine guarantee:

- TypeScript (`twa-verimie-admin`): about 491 ms first native snapshot query, then 42.5 ms / 35.7 ms warm semantic queries
- Dart (`twa-verimie-app`): first context returns `warming` in about 5.7 ms; cold analyzer + symbol-index work completes in the background in about 14.5 s; the same exact-symbol query then returns in about 6.3 ms with 16 in-project references
- Java (`twa-verimie-service`): Maven/JDT cold import and indexing took about 87.6 s in the isolated background workspace; after indexing, `PromotionRepo` workspace-symbol lookup took about 510 ms
- CodeGraph (`twa-verimie-service`): location-only `codegraph_search` measured about 198 ms cold and 6.95 ms warm with ~1.1 KB output, while a bounded four-file `codegraph_explore` measured about 474 ms with ~25 KB upstream output; LCA therefore reserves explore for deep flow/architecture requests and independently caps provider output

The Phase 8 runtime benchmark reports a representative local run of roughly 0.2 ms average action-pipeline overhead, effectively zero measured p95 delay before action-body start, sub-microsecond conversation-context scope overhead, and Code Mode latency improvement well above the 15% ship threshold on independent-read workloads. Exact measurements are intentionally rerunnable with `npm run benchmark:runtime` and `npm run benchmark:code-mode` rather than frozen as universal hardware claims.

## Release gates

`npm run test:all` verifies:

- TypeScript typecheck and unit tests
- live CodeGraph context integration
- filesystem, semantic, CodeGraph, and AgentMemory parallel fan-out
- AgentMemory lifecycle, decisions, and supervisor recovery
- persistent HTTP MCP connection semantics
- Figma, DBeaver, Bruno, Penpot, Coolify, and Notion contracts
- nineteen-tool schema and complete internal action coverage
- runtime event ordering, trajectory, Code Mode, and reversible runtime composition
- generated architecture contract drift and optional metadata-only OTLP export
- direct absolute-path, command, Git, delete, and desktop execution
- auth header handling, origin rejection, body caps, audit redaction, undo isolation, and process cleanup
- Pro snapshot, widget resources, project search, manual verification, and review flows
- end-to-end eval scenarios

## Definition of done

The release is complete when the full gate passes, the benchmark meets all budgets, `lca-custom doctor --json` is healthy, the live server reports `trusted-local` and `compact`, `workspace_context` returns coverage for filesystem, semantic analysis, CodeGraph, and AgentMemory, the active tunnel is reused, and the Git working tree is clean after the release commit.
