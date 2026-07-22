# Managed AgentMemory runtime

AgentMemory runs as a companion local service rather than inside the LCA MCP server process.
This separation keeps its runtime, optional embedding packages, iii-engine dependencies, and security audit surface out of the core server.

The LCA installer must run `npm ci` in this directory on every machine, then start the pinned CLI from `node_modules/.bin/agentmemory`. The checked-in `.npmrc` omits optional ONNX and local-embedding packages, keeping the default runtime on BM25 search with a much smaller install and audit surface.
The LCA dependency supervisor owns health checks, startup, restart, export, and import.

Do not expose AgentMemory tools directly to ChatGPT. LCA queries it internally through the `MemoryPort` adapter so every `workspace_context` call includes memory coverage.
