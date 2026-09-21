import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { ConversationRuntimeContext } from "./conversation-runtime-context.js";

const primary = path.resolve("/tmp/lca-runtime-primary");
const secondary = path.resolve("/tmp/lca-runtime-secondary");

test("runtime context carries project, execution defaults, and correlation independently", async () => {
  const runtime = new ConversationRuntimeContext({ primaryRoot: primary, roots: [primary, secondary] });
  await runtime.run({
    primaryRoot: secondary,
    conversationId: "chat-a",
    sessionId: "session-a",
    runner: "codex",
    isolation: "worktree",
    networkAccess: true,
    correlationId: "corr-a"
  }, async () => {
    await Promise.resolve();
    assert.equal(runtime.primaryRoot(), secondary);
    assert.equal(runtime.current().conversationId, "chat-a");
    assert.equal(runtime.current().correlationId, "corr-a");
    assert.equal(runtime.current().networkAccess, true);
  });
  assert.equal(runtime.primaryRoot(), primary);
});
