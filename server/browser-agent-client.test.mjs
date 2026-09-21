// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_BROWSER_AGENT_MCP_URL,
  callBrowserAgentTool
} from "./browser-agent-client.mjs";

test("uses a browser-agent port distinct from the main LCA default", () => {
  assert.equal(DEFAULT_BROWSER_AGENT_MCP_URL, "http://127.0.0.1:8791/mcp");
});

test("rejects non-browser tools before opening an MCP connection", async () => {
  await assert.rejects(
    () => callBrowserAgentTool("read_file", {}),
    /Only browser_\* tools/
  );
});
