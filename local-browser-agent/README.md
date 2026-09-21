# Local Browser Agent

Local Browser Agent is a Chromium visual-review, Cheerio-scraping, and control connector for ChatGPT and other MCP clients. It combines a loopback MCP server with a Manifest V3 extension to capture screenshots, sanitized live HTML, DOM snapshots, computed CSS, box geometry, console output, network metadata, performance metrics, accessibility state, and observable DevTools state from a user-approved tab. It can also navigate, inspect, click, hover, focus, type, press keys, scroll, select options, query page markup with Cheerio, and click the Nth scraped match.

## Current milestone

The repository starts with a technical-spike architecture:

- authenticated loopback WebSocket bridge;
- one-time pairing code and rotating session token;
- shared protocol schemas;
- MCP tools for status, tab discovery, capture, artifact reads, and deletion;
- Manifest V3 service worker and DevTools companion;
- Chrome DevTools Protocol capture and trusted input automation;
- a DevTools companion path that coexists with another coding extension;
- full-screen review bundles containing screenshot, sanitized `page.html`, DOM, computed styles, layout and debug signals;
- server-side Cheerio selectors, extraction, stable selector generation, and scrape-then-click actions.

## Quick start

```bash
npm install
npm run check
npm link
lba start --background --no-tunnel
lba pairing
```

Load `apps/extension/dist` as an unpacked extension in Chromium, enter the pairing code, then choose **Allow full control for active tab**. Approval follows that tab across HTTP/HTTPS navigation for eight hours and is revoked when the tab closes.

Full setup instructions are in [`docs/SETUP.md`](docs/SETUP.md). Security boundaries and residual risks are documented in [`SECURITY.md`](SECURITY.md).

Local endpoints default to:

- MCP: `http://127.0.0.1:8791/mcp`
- Health: `http://127.0.0.1:8791/healthz`
- Extension bridge: `ws://127.0.0.1:8791/bridge`

The server prints a short-lived pairing code. Enter it in the extension popup.

## Security defaults

- loopback binding only;
- exact Chromium extension origin validation;
- one-time pairing code;
- random rotating bridge token;
- no cookies, authorization headers, request bodies, response bodies, storage values, or password values in default captures;
- capture artifacts stored outside the inspected project and expired by TTL;
- separate, expiring full-control approval for each tab;
- debugger sessions detached after one-shot captures;
- incognito disabled unless explicitly enabled later.

This is not a browser sandbox. The `debugger` permission is powerful and should only be installed from a trusted build.

## MCP tools

- `browser_status`
- `browser_list_tabs`
- `browser_capture`
- `browser_review`
- `browser_scrape`
- `browser_click_match`
- `browser_navigate`
- `browser_interact`
- `browser_inspect`
- `browser_capture_read`
- `browser_capture_delete`

Capture artifacts are also available through `browser://capture/{captureId}/{artifact}` MCP resources.

## UI review workflow

1. Approve the target tab in the extension popup.
2. Call `browser_review` to receive the rendered screenshot plus `page.html`, `dom.json`, `visual.json`, console, network, performance, accessibility and DevTools artifacts.
3. Use `browser_inspect` on a suspicious selector or accessible role/name to read its exact box model, computed padding, margins, colors, typography and matched CSS rules.
4. Use `browser_interact` or `browser_navigate` to reach another state, with `captureAfter` left enabled for an immediate post-action review bundle.

## Cheerio scraping and click matching

`browser_scrape` captures the current live markup from the approved tab, removes scripts and inline event handlers, redacts sensitive form fields and token-like URL parameters, then parses the result on the local MCP server with Cheerio.

```text
browser_scrape {
  "selector": ".promo",
  "extract": ["text", "attributes", "href", "outerHTML"]
}
```

Use `containsText` or `exactText` to filter in DOM order. Every match includes a generated CSS selector that can be used against the live page.

`browser_click_match` performs the scrape and click as one operation. `position` is 1-based:

```text
browser_click_match {
  "selector": ".promo",
  "position": 2,
  "captureAfter": true
}
```

Cheerio parses HTML but does not render CSS or execute page JavaScript. The extension still uses CDP or the DevTools companion for the actual click and post-action capture.

When Chrome DevTools is open, the companion path uses `chrome.devtools` APIs so a separate code-editing extension can remain active. Close DevTools when exact CDP matched-rule provenance or trusted input dispatch is required.
