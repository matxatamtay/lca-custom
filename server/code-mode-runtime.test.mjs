import test from "node:test";
import assert from "node:assert/strict";

import { runCodeMode } from "./code-mode-runtime.mjs";

test("Code Mode executes TypeScript and bridges concurrent LCA bindings", async () => {
  const calls = [];
  const result = await runCodeMode({
    program: `
      const actions: string[] = ['one', 'two', 'three'];
      const values = await Promise.all(actions.map((action) => lca.read(action, { n: action.length })));
      console.log('done');
      return values;
    `,
    dispatch: async (facade, action, args) => {
      calls.push({ facade, action, args });
      return { action, n: args.n };
    }
  });
  assert.deepEqual(result.value.map((item) => item.action), ["one", "two", "three"]);
  assert.equal(calls.length, 3);
  assert.deepEqual(result.logs, ["done"]);
});
