# LCA Next server architecture

This directory is the incremental replacement for the legacy `server.mjs` monolith.
The existing runtime remains the production entrypoint until contract and eval parity is proven.

Dependency direction:

```text
interfaces -> application -> domain
adapters   -> ports       -> domain
bootstrap  -> application + adapters
```

Core rules:

1. Application use cases do not import MCP, HTTP, filesystem, process, or vendor SDKs.
2. CodeGraph and AgentMemory are mandatory context providers, not optional model-selected tools.
3. `workspace_context` must produce a coverage receipt proving filesystem, CodeGraph, and AgentMemory were queried.
4. Provider failures are surfaced explicitly. There is no silent fallback that pretends context is complete.
5. The target ChatGPT-facing MCP surface stays at twenty tools or fewer.

The first vertical slice is `BuildTaskContext`. Real CodeGraph and AgentMemory adapters will replace test doubles in later slices.
