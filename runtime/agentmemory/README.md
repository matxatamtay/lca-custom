# Managed AgentMemory runtime

AgentMemory runs as a companion local service rather than inside the LCA MCP server process.
This separation keeps its runtime, optional embedding packages, iii-engine dependencies, and security audit surface out of the core server.

The LCA installer must run `npm ci` in this directory on every machine, then start the pinned CLI from `node_modules/.bin/agentmemory`. Local embedding requires the direct `@huggingface/transformers` dependency, its ONNX runtime binaries, and platform-specific optional native packages, so optional dependencies and installation scripts must not be omitted.
Set `EMBEDDING_PROVIDER=local` in `~/.agentmemory/.env` to opt into the free on-device `Xenova/all-MiniLM-L6-v2` model (384 dimensions). The model is downloaded on first use; without the setting, the runtime safely falls back to BM25.

LCA applies a source-bundle compatibility patch during installation/startup and symlinks the package's `data` directory to this runtime's ignored `data/` directory. This keeps the database outside `node_modules` so subsequent reinstalls do not destroy memories. Back up any preexisting package-local database and migrate it into `runtime/agentmemory/data` before installing; the patch intentionally refuses to overwrite a nonempty unsymlinked directory.

The LCA dependency supervisor owns health checks, startup, restart, export, and import.

Do not expose AgentMemory tools directly to ChatGPT. LCA queries it internally through the `MemoryPort` adapter so every `workspace_context` call includes memory coverage.
