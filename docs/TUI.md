# Local Coding Agent TUI

`lca-custom tui` opens a full-screen terminal interface backed by the same fourteen compact MCP tools used by ChatGPT. It supports keyboard navigation and terminal mouse events. Closing the TUI leaves the managed LCA server and tunnel running.

## Start

```bash
lca-custom tui
```

The launcher verifies the managed dependency fingerprint, starts the server and tunnel when necessary, and then opens the TUI against the configured local MCP endpoint. Installed CLI wrappers pin both their source checkout and config path, so an isolated development or recovery instance cannot silently borrow another instance's projects, port, or tunnel.

Requirements:

- an interactive terminal with ANSI support
- Node.js 20+
- a configured LCA project
- Windows Terminal, iTerm2, Terminal.app, Kitty, WezTerm, GNOME Terminal, Konsole, or another xterm-compatible terminal for the best mouse experience

## Screens

| Screen | What it does |
|---|---|
| Dashboard | Server, tunnel, doctor, AgentMemory, and desktop-integration health |
| Projects | Add, remove, promote a primary project, and open a project in Files |
| Files | Clickable directory browser and text-file reader with absolute-path support |
| Search | ripgrep-backed workspace search with direct jump to matching lines |
| Context | Mandatory filesystem + CodeGraph + AgentMemory context and coverage receipt |
| Git | Status, per-file diff, staged diff, log, branches, and repository switching |
| Commands | Bounded foreground command runner with history and selectable working directory |
| Processes | Start, inspect, and stop managed background processes |
| Verify | Detect commands, run focused tests/build/lint, review diffs, security scan, and quality gates |
| Tasks & Notes | Task plans, step completion, local notes, checkpoints, and patch undo |
| Skills | List, read, create, and delete reusable LCA skills |
| Integrations | Live Figma, DBeaver, and Bruno status plus action discovery |
| Memory | AgentMemory health, private backup-directory export, offline validation, and safe import |
| Tool Console | Inspect the 14 compact tools, discover hidden actions, and call any façade with JSON |
| Logs | Tail launcher, lifecycle, and audit logs |
| Help | Complete keyboard and mouse reference |

The Tool Console is the complete-capability escape hatch. It can reach all hidden backend actions while preserving the compact public MCP contract.

## Input

- Click navigation rows, action buttons, list rows, modal buttons, and scrollbars.
- Use the mouse wheel over lists and detail panes.
- Use `Tab` and `Shift+Tab` to cycle keyboard focus.
- Use arrow keys or `j` / `k` in focused lists.
- Press `Enter` to open the selected row.
- Press `Ctrl+P` for the command palette.
- Press `r` to refresh the active screen.
- Press `/` to open Search.
- Press `q` or `Ctrl+C` to leave the TUI.

Direct screen shortcuts:

```text
d dashboard   p projects      f files       / search
x context     g git           c commands    o processes
v verify      t tasks/notes   k skills      i integrations
m memory      a tool console  l logs        h help
```

## Project semantics

Project roots are discovery and routing defaults, not authorization boundaries.

- **Primary project:** default for relative paths, CodeGraph indexing, and AgentMemory project scope.
- **Additional projects:** included in cross-project search and context.
- **Absolute paths:** continue to work even when a path is not registered.

The Projects screen uses the launcher commands below, so server restart and tunnel-singleton behavior remain centralized:

```bash
lca-custom add /path/to/project
lca-custom remove /path/to/project
lca-custom primary /path/to/project
```

`primary` reorders the existing project list without dropping secondary roots. `reset` still replaces the whole list with one project.

## Architecture

The TUI is a separate MCP client, not an import of the server monolith:

```text
neo-blessed renderer
        ↓
LcaTuiClient
        ↓ persistent Streamable HTTP
14 compact MCP façades
        ↓ in-memory backend
136 implementation actions
```

Project mutation and AgentMemory portability operations go through a small launcher subprocess bridge. Credentials and the config path are passed by environment rather than command-line arguments. The persistent MCP client reconnects once after server restarts or transport replacement.

The UI dependency is pinned in `server/package-lock.json` and installed by the existing managed-runtime installer. Unit tests run on Windows, macOS, and Linux; a Linux pseudo-terminal smoke test also verifies full rendering, SGR mouse input, a single-click Projects navigation, and clean raw-mode exit.
