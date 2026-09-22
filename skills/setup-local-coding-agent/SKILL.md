---
name: setup-local-coding-agent
description: Install Local Coding Agent for a customer using the universal CLI, safe defaults, and verification checks.
---

# Setup Local Coding Agent

Use this when a customer asks an AI agent to clone, install, configure, and
start Local Coding Agent.

## Rules

- Do not install system dependencies without asking first.
- Let the setup wizard download `tunnel-client` when possible; fall back to a
  customer-provided path if download/extraction fails.
- Do not print, commit, or upload API keys, tunnel IDs, auth tokens, or local config.
- LCA is trusted-local/direct-only. Do not configure Codex, Hermes, delegated model providers, or a secondary agent runner.

## Steps

1. Check prerequisites:
   - `node -v` must be 20 or newer.
   - `npm --version`, `git --version`, and `docker --version` should work.
2. Clone the repo if needed:
   - `git clone https://github.com/matxatamtay/lca-custom.git`
3. Enter the repo and run setup wizard:
   - Windows: `scripts\lca-custom.cmd setup`
   - macOS/Linux/WSL: `bash scripts/lca-custom setup`
4. Let the wizard ask the customer for:
   - workspace path
   - Tunnel ID
   - Runtime API key for `.env.local`
   - tunnel-client path only if auto-download fails
5. Select and start the target workspace:
   - `lca-custom reset /path/to/workspace`
   - `lca-custom start --background`
   - use `--no-tunnel` only when a local-only MCP server is desired
6. Verify:
   - MCP: `http://127.0.0.1:8790/mcp`
   - Health: `http://127.0.0.1:8790/healthz`
   - `lca-custom status`
   - `lca-custom doctor`

## Report Back

Return:

- repo path
- workspace path
- MCP URL
- health URL
- direct-only runtime status
- tunnel status
- any missing requirement and the exact next fix
