# Setup

## Prerequisites

- Node.js 20 or newer
- npm
- Chromium 118 or newer
- Optional: OpenAI `tunnel-client`, Tunnel ID, and Runtime API key for ChatGPT Web

## Build

```bash
npm install
npm run check
```

The build produces:

- MCP server: `dist/server/index.mjs`
- unpacked Chromium extension: `apps/extension/dist`

## Install the local CLI

From this repository:

```bash
npm link
```

This exposes the `lba` command. It can also be run without linking:

```bash
node scripts/lba.mjs status
```

## Start locally

```bash
lba start --background --no-tunnel
```

Useful commands:

```bash
lba status
lba pairing
lba doctor
lba stop
```

Default endpoints:

- MCP: `http://127.0.0.1:8791/mcp`
- health: `http://127.0.0.1:8791/healthz`
- extension bridge: `ws://127.0.0.1:8791/bridge`

## Load the Chromium extension

1. Open `chrome://extensions` or the matching extensions page in Chromium.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select `apps/extension/dist`.
5. Open the Local Browser Agent popup.
6. Run `lba pairing` in a terminal.
7. Enter the six-digit pairing code.
8. Open the tab that may be reviewed or controlled and choose **Allow full control for active tab** in the extension popup.

Pairing authorizes the extension instance. Tab approval is separate, bound to the tab, follows it across HTTP/HTTPS navigation, expires after eight hours, and is revoked when the tab closes or enters a non-web URL.

## Connect through the OpenAI Secure MCP Tunnel

Set local environment values without committing them:

```bash
export CONTROL_PLANE_TUNNEL_ID="tunnel_..."
export CONTROL_PLANE_API_KEY="sk-proj-..."
export TUNNEL_BIN="/absolute/path/to/tunnel-client"
```

Then run:

```bash
lba start --background
```

The CLI writes a tunnel profile under `~/.local-browser-agent/profiles` unless `TUNNEL_PROFILE_DIR` is set.

In ChatGPT Web:

1. Open Settings → Connectors.
2. Enable Developer mode.
3. Add a custom MCP connector using the created secure tunnel.
4. Use `No auth` unless `LBA_MCP_AUTH_TOKEN` is configured.
5. Call `browser_status` to verify the connector.

When `LBA_MCP_AUTH_TOKEN` is set, the CLI also configures the tunnel to forward the matching bearer header.

## First capture

After pairing and approving a tab, call:

```text
browser_capture
```

The default capture includes:

- visible screenshot;
- interactive DOM summary;
- console events observed during debugger capture;
- network metadata observed during debugger capture;
- performance metrics;
- accessibility tree;
- observable DevTools state.

Large artifacts are stored locally and returned as `browser://capture/...` resource URIs. They can also be read through `browser_capture_read`.

## Visual review and browser control

For a complete UI review, call:

```text
browser_review
```

The result includes the screenshot directly for vision analysis and stores sanitized live markup as `page.html`, plus full DOM, computed CSS, box geometry, viewport/media state, console, network, performance, accessibility and DevTools metadata as artifacts.

Scrape the current live markup with Cheerio:

```text
browser_scrape {
  "selector": ".promo",
  "extract": ["text", "attributes", "href", "outerHTML"]
}
```

Click the second scraped match and immediately capture the result:

```text
browser_click_match {
  "selector": ".promo",
  "position": 2,
  "captureAfter": true
}
```

`position` is 1-based. `containsText` and `exactText` can narrow matches before the position is applied.

Navigate while keeping the same approved tab:

```text
browser_navigate { "url": "http://localhost:3000/settings", "waitUntil": "networkidle" }
```

Inspect exact CSS and layout:

```text
browser_inspect { "element": { "selector": ".settings-card" } }
```

Interact and immediately capture the resulting screen:

```text
browser_interact {
  "action": { "kind": "click", "element": { "role": "button", "name": "Save" } },
  "captureAfter": true
}
```

Supported actions are `inspect`, `click`, `hover`, `focus`, `type`, `press`, `scroll`, `select`, and `wait`. Elements can be targeted by CSS selector, visible text, accessible role/name, backend node id, or viewport coordinates.

## DevTools companion mode

When Chrome DevTools is open on a tab, Chromium does not allow the extension debugger to own the same inspected target. The extension automatically switches to its DevTools companion path.

In that mode:

- HAR data is available from the time DevTools was opened;
- selected Elements state is available;
- sanitized HTML, DOM, computed styles, visual state and performance data use inspected-window evaluation;
- interactions use JavaScript events and may differ from trusted CDP input;
- full-page screenshot falls back to the visible viewport;
- existing Console panel history is not exposed by Chrome extension APIs.

## Data location

Runtime data defaults to:

```text
~/.local-browser-agent
```

It contains:

- audit metadata;
- capture artifacts;
- process state;
- pairing code file;
- tunnel profiles;
- launcher logs.

Override it with `LBA_DATA_DIR`.
