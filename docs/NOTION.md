# Notion Integration

LCA exposes Notion as a first-class compact integration plus an interactive ChatGPT Apps SDK page widget.

## Configure the key from the TUI

1. Run `lca-custom tui`.
2. Open **Integrations** (`i`).
3. Click **Notion Key**.
4. Paste the Notion integration token into the censored prompt.
5. Restart LCA from the TUI.
6. Return to **Integrations** and click **Refresh**.

The TUI stores the secret as `NOTION_API_KEY` in the repository `.env.local`. Secret values are masked in list/detail output, and the env file is written with mode `600` where supported. The running daemon only reloads the new value after Restart.

Optional variables:

```env
NOTION_VERSION=2026-03-11
NOTION_API_BASE=https://api.notion.com/v1
NOTION_TIMEOUT_MS=30000
```

`NOTION_API_KEY` is never returned by MCP tools, inserted into widget state, or copied into ChatGPT model context.

## Notion-side access

The integration can only access content available to the Notion connection. Share the pages/data sources that LCA needs with that connection and grant the required read/update/insert capabilities.

## Compact facade

ChatGPT sees one `notion` facade. Common actions are:

```text
notion action=status
notion action=actions
notion action=search
notion action=fetch
notion action=create
notion action=update
notion action=replace
notion action=call
```

`call` accepts only an allow-listed relative Notion API path; it cannot be used as an arbitrary external HTTP client.

## ChatGPT page widget

Call:

```text
notion_page
```

or open a page directly:

```text
notion_page page_id=<page-id>
```

The app can:

- search pages shared with the connection
- open and refresh a page
- render enhanced Markdown as readable blocks
- select one or more rendered blocks
- select ordinary text in the rendered page
- edit the page body as enhanced Markdown
- save with optimistic `last_edited_time` conflict detection
- open the canonical page in Notion
- request ChatGPT fullscreen mode
- add a page reference, selected blocks, selected text, or page metadata to ChatGPT
- send the selected context directly to ChatGPT with **Ask ChatGPT**

### Add to ChatGPT

**Add page to ChatGPT** inserts a lightweight page reference into the conversation. It intentionally does not copy the whole page into model context. When the page body is needed, ChatGPT can call:

```text
notion action=fetch arguments={"page_id":"..."}
```

**Add selected blocks** and **Add selected text** put only the selected content into the conversation context. The widget stores no Notion credential.

## `@notion:` in `lca_input`

Inside `lca_input`, type:

```text
@notion:architecture
```

Autocomplete searches Notion. Selecting a result inserts a stable reference:

```text
@notion:<page-id>
```

The composed prompt explains that the page should be fetched lazily through `notion action=fetch`. This keeps large Notion pages out of the prompt until they are actually needed.

## Safe writes

The widget sends its base `last_edited_time` with Save. Before replacing Markdown, LCA fetches the current page metadata. If the remote timestamp changed, the write fails with a conflict instead of overwriting newer remote edits.

Full-page replacement uses Notion enhanced Markdown with child-content deletion disabled by default. `allow_deleting_content` must be explicitly enabled by a direct tool caller if that behavior is genuinely intended.

If Notion reports `truncated` content or any `unknown_block_ids`, the ChatGPT widget locks full-page Edit/Save. Read, selection, and Add to ChatGPT remain available. This prevents a partial Markdown representation from being written back as if it were complete.

Targeted automation should prefer `notion action=update` when a small search/replace edit is enough, and use `replace` for deliberate whole-page replacement.

## Current editor boundary

The first editor is an enhanced-Markdown page editor with a Notion-like read view and selectable blocks. It is not a clone of every native Notion block interaction: drag/reorder, column layout editing, inline property editors, and database view builders remain native-Notion features for now. Content added to ChatGPT is explicitly labeled as untrusted reference data rather than higher-priority instructions.

The data path is already structured so richer block controls can be added without exposing credentials or changing the public `notion` facade.

## Tests

```bash
cd server
npm run test:notion
npm run test:notion:widget
npm run test:compact
npm run test:tui
```

Mock tests cover token isolation, API/version headers, search, enhanced-Markdown retrieval, optimistic conflict rejection, safe replacement defaults, generic-path restrictions, Apps SDK context hooks, and `@notion:` discovery wiring.
