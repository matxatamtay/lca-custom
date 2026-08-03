# Persistent Memory and Shared Task Protocol

Local Coding Agent stores long-lived context in an **Obsidian-compatible Markdown vault** and keeps execution state in structured task briefs. The model still runs through one MCP tunnel; this protocol improves continuity, scope control, and handoffs without pretending to spawn model agents.

## Memory vault

Default vault locations:

- Linux: `~/.local/share/local-coding-agent/vault`
- macOS: `~/Library/Application Support/LocalCodingAgent/Vault`
- Windows: `%LOCALAPPDATA%\LocalCodingAgent\Vault`

Override with:

```env
AGENT_MEMORY_VAULT=/path/to/your/obsidian-vault
```

Open that folder in Obsidian with **Open folder as vault**. LCA creates:

```text
Global/                       memories shared across projects
Projects/<workspace-id>/      memories scoped to one project
Tasks/<workspace-id>/         task briefs and typed knowledge
README.md                     vault guide
```

Memory notes use YAML frontmatter and Obsidian `[[wikilinks]]`. The frontmatter records `key`, `scope`, `source`, project ID, timestamps, tags, and links. LCA searches by frontmatter, so notes may be renamed in Obsidian without becoming invisible.

Do not store passwords, API keys, tokens, private keys, or other secrets in the vault.

## Memory tools

- `memory_status`: show the active vault and folder layout.
- `context_pin`: create or update a permanent memory with explicit provenance.
- `context_list`: list or full-text search memories.
- `context_explain`: read one memory and explain where it came from.
- `context_remove`: delete one memory.

Example:

```json
{
  "key": "workflow.commit",
  "value": "Do not commit unless the user explicitly requests it.",
  "scope": "global",
  "source": "user",
  "tags": ["workflow"],
  "links": ["Tasks"]
}
```

## Structured task briefs

`task_brief` creates a stable `task_id` with:

- goal and in-scope work
- explicit exclusions
- constraints
- definition of done
- test, commit, and confirmation policies
- optional path allow/deny rules

The brief is stored as JSON under `.agent/state/tasks/` for reliable machine use and mirrored as Markdown under the vault's `Tasks/` folder.

`intent_check` returns a compact interpretation plus an `intent_checksum`. It separates task facts, assumptions, decisions, and open questions instead of blending them into one paragraph.

`knowledge_state` stores typed entries:

- `fact`
- `assumption`
- `decision`
- `open_question`

Every entry includes provenance and lifecycle status.

## Scope guards

`scope_guard` accepts `allowed_paths` and `denied_paths`. Deny patterns win. Patterns are project-relative and support `*`, `**`, and `?`.

```json
{
  "action": "set",
  "task_id": "w10-selectors",
  "allowed_paths": ["crates/css/**", "docs/**"],
  "denied_paths": ["server/package-lock.json", ".agent/**"]
}
```

The guard is enforced by `write_file`, `replace_in_file`, `apply_patch`, `make_dir`, `move_path`, and `delete_path`. Command tools accept `touches` declarations so expected mutations can be checked too.

## Dependency-aware task orchestration

`parallel_tasks` is command orchestration, not a model runtime. Tasks may declare:

- `depends_on`
- `always_run`
- `allow_failure`
- `consumes`
- `produces`
- `touches`

The graph is validated for missing dependencies and cycles. Failed dependencies block normal descendants. `allow_failure` lets dependents continue, while `always_run` supports cleanup and reporting. `fail_fast` skips unscheduled normal work but preserves cleanup tasks.

## Result digests and handoffs

Write and command tools return a compact `result_digest` with:

- summary
- facts
- changed files
- blockers
- recommended next action
- task ID

`handoff_packet` builds a structured continuation packet. `checkpoint` saves the same packet, and `resume` restores it in a fresh chat. The packet includes task contract, typed knowledge, scope guard, progress, tests, files, git state, and memory-vault location.
