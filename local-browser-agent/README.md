# Local Browser Agent

The browser sidecar now uses **browser-use/jev-ultrafast + Browser Harness** as its default agent/control path while preserving the existing loopback MCP endpoint on port 8791. That keeps the LCA-facing contract stable: the browser sidecar can be rebuilt/restarted independently without restarting the main LCA process.

`browser_agent` runs a natural-language goal through Jev Ultrafast. Browser Harness owns the CDP/browser session and exposes direct browser primitives through `browser_harness_call`. LCA should resolve test-case input data first and pass it as `inputValues` (for example `{"email":"qa@example.com","search":"promo"}`). Jev chooses the field/action, while the actual text comes deterministically from those supplied values. A separate text-model API key is not required. In `LBA_BROWSER_MODE=auto`, the sidecar first attempts the user's remote-debug-enabled Chromium session; if that is unavailable it automatically starts a persistent isolated headless Chrome profile on port 9223.

The previous Manifest V3 extension/CDP implementation remains available as a **diagnostic fallback** for rich captures such as sanitized HTML, DOM snapshots, computed CSS, box geometry, console output, network metadata, performance metrics, accessibility state, and observable DevTools state.

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
- server-side Cheerio selectors, extraction, stable selector generation, and scrape-then-click actions;
- Browser Harness MCP as the default browser transport;
- Jev Ultrafast for low-latency observed-element action selection;
- isolated-browser fallback so normal browser automation does not require enabling remote debugging on the user's main Chrome profile.

## Quick start

```bash
npm install
npm run check
npm link
lba start --background --no-tunnel
lba pairing
```

For Jev/Browser Harness automation, the extension is not required. With `LBA_BROWSER_MODE=auto`, Browser Harness uses a remote-debug-enabled real Chromium session when available and otherwise starts the isolated persistent browser profile automatically.

Load `apps/extension/dist` only when legacy rich capture/review/debugging is needed. The extension bridge remains compatible with the same sidecar.

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
- `browser_agent` — Jev Ultrafast natural-language browser goal
- `browser_harness_actions` — live Browser Harness tool catalog
- `browser_harness_call` — direct Browser Harness primitive/CDP access
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

## Restart behavior

The LCA main process talks to this sidecar over `http://127.0.0.1:8791/mcp`. Browser tools are discovered dynamically, so changing/rebuilding the sidecar does **not** require an LCA restart. Restart only the sidecar when TypeScript code changes.

Jev credentials are re-read from the parent repository's `.env.local` for each `browser_agent` call. Adding or rotating `JEV_API_TOKEN` or `TYPESAFE_API_KEY` therefore does not require restarting LCA or the browser sidecar.

There is no separate text model. If Jev chooses `TYPE_TEXT`, the runner matches the selected field against caller-provided `inputValues` using exact/normalized field labels and deterministic label matching. If LCA did not provide the required value, the action fails explicitly instead of generating or guessing text.

Jev Ultrafast is pinned to a tested Git commit and runs under Python 3.12. Browser Harness is pinned to 0.1.13.

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
