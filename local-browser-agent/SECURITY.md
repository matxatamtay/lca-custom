# Security

Local Browser Agent gives a trusted local AI connector visibility and control over browser tabs that the user explicitly approves. Chromium's `debugger` permission is powerful and can navigate pages, synthesize input, inspect DOM/CSS and observe network activity. Install only builds you trust.

## Trust boundaries

- The MCP server binds only to `127.0.0.1`.
- Browser WebSocket connections must present an exact `chrome-extension://<extension-id>` Origin.
- The extension must pair with a short-lived one-time code.
- The resulting random token is bound to the extension ID and Origin, stored locally, and expires.
- Pairing does not grant tab access. Each tab requires separate full-control approval.
- Approval follows the same tab across HTTP/HTTPS navigation, expires after eight hours, and is revoked when the tab closes or enters a non-web URL.
- Incognito capture is disabled.

## Capture and control defaults

The default capture is read-only and does not include:

- cookies or `Set-Cookie`;
- authorization or proxy authorization values;
- request bodies;
- response bodies;
- localStorage, sessionStorage, or IndexedDB values;
- password and editable accessibility values;
- file input paths;
- URL fragments;
- common token-like query values.

Secret-looking bearer tokens, OpenAI-style keys, and JWTs are redacted from textual artifacts when detected. Redaction is defense in depth, not a guarantee that arbitrary page text or pixels contain no sensitive information.

## HTML and Cheerio scraping

HTML snapshots are sanitized twice, once in the extension before crossing the loopback bridge and again in the server before `page.html` is stored. Both layers remove scripts, styles, inline event handlers, nonces and `srcdoc`; normalize URLs; redact common token-like query parameters; and replace sensitive input, textarea and editable values. Cheerio queries run only against this sanitized snapshot.

Cheerio does not reproduce rendering, computed styles, JavaScript execution, closed shadow roots, or browser event behavior. A generated selector is resolved again against the live page before interaction, so a rapidly changing page can still produce a stale-match failure rather than clicking the intended node.

Navigation and interaction tools can trigger real application behavior, including form submission, account changes, purchases, deletion buttons, or external requests. The MCP tool annotations mark these operations as non-read-only, but the approved tab remains a high-trust capability. Review the requested action and target before granting full control.

## Screenshots

Screenshots may visibly contain private information. A screenshot is returned only after the extension is paired and the current tab has been explicitly approved. Review the active page before requesting a capture.

## DevTools limitations

When DevTools is already open, the extension uses Chrome DevTools extension APIs rather than `chrome.debugger`. This permits coexistence with another development extension, but synthetic JavaScript events are not browser-trusted input and matched stylesheet rule provenance is unavailable. Coverage differences are included in each result. Do not assume HAR or console history is complete.

## Local artifacts

Artifacts are stored under `~/.local-browser-agent/captures` by default and expire automatically. Files are addressed only by validated capture and artifact identifiers. Audit logs contain metadata and redacted arguments, not screenshot bytes or raw DOM bodies.

## Network exposure

Do not expose the local server through an arbitrary public tunnel. Use the OpenAI Secure MCP Tunnel or another authenticated private channel. Set `LBA_MCP_AUTH_TOKEN` when additional bearer authentication is needed.

## Residual risks

- A compromised or malicious approved page can place sensitive content in visible text, console messages, URLs, or screenshots.
- Chrome extension permissions apply at browser-profile scope even though Local Browser Agent adds its own consent gate.
- DevTools Protocol and extension APIs can change across Chromium versions.
- A page can react differently to trusted CDP input and untrusted DevTools companion events.
- HTML sanitization and token heuristics cannot guarantee removal of every application-specific secret embedded in ordinary text or custom attributes.
- This project does not provide OS-level isolation.
