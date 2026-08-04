import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { ConversationProjectScope } from "./conversation-project-scope.js";

const primary = path.resolve("/tmp/lca-primary");
const secondary = path.resolve("/tmp/lca-secondary");

function createScope(): ConversationProjectScope {
  return new ConversationProjectScope({ primaryRoot: primary, roots: [primary, secondary] });
}

test("unscoped conversations preserve the global multi-project defaults", () => {
  const scope = createScope();
  assert.equal(scope.primaryRoot(), primary);
  assert.deepEqual(scope.discoveryRoots(), [primary, secondary]);
  assert.equal(scope.isScoped(), false);
});

test("a conversation may scope its default to a project or nested folder", async () => {
  const scope = createScope();
  const nested = path.join(secondary, "packages", "api");

  await scope.run(nested, async () => {
    await Promise.resolve();
    assert.equal(scope.primaryRoot(), nested);
    assert.deepEqual(scope.discoveryRoots(), [nested]);
    assert.equal(scope.isScoped(), true);
  });

  assert.equal(scope.primaryRoot(), primary);
  assert.deepEqual(scope.discoveryRoots(), [primary, secondary]);
});

test("parallel conversations keep independent primary folders", async () => {
  const scope = createScope();
  const first = path.join(primary, "one");
  const second = path.join(secondary, "two");

  const [left, right] = await Promise.all([
    scope.run(first, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return scope.primaryRoot();
    }),
    scope.run(second, async () => {
      await Promise.resolve();
      return scope.primaryRoot();
    })
  ]);

  assert.equal(left, first);
  assert.equal(right, second);
  assert.equal(scope.primaryRoot(), primary);
});

test("conversation selection cannot silently introduce an unregistered root", () => {
  const scope = createScope();
  assert.throws(
    () => scope.run("/tmp/not-configured", () => undefined),
    /inside a configured project root/
  );
});
