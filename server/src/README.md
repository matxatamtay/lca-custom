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
2. CodeGraph and AgentMemory remain mandatory context providers; native semantic analysis runs alongside them and degrades explicitly when a language backend is unavailable.
3. `workspace_context` must produce a coverage receipt proving filesystem, semantic analysis, CodeGraph, and AgentMemory were queried.
4. Provider failures are surfaced explicitly. There is no silent fallback that pretends context is complete.
5. The target ChatGPT-facing MCP surface stays at sixteen tools or fewer.

`BuildTaskContext` combines current filesystem evidence, language-native semantic evidence, CodeGraph relationships, and AgentMemory. TypeScript/JavaScript uses the persistent TypeScript 7 native API, Dart/Flutter uses a persistent Dart Analysis Server LSP session with background prewarming, and Java uses persistent Eclipse JDT LS with project-isolated workspace data. Semantic cold starts report `warming` rather than blocking the required context lanes.
