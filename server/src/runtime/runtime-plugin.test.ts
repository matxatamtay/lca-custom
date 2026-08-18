import test from "node:test";
import assert from "node:assert/strict";

import { RuntimePluginHost } from "./runtime-plugin.js";

test("runtime plugins unwind effects in reverse mount order", async () => {
  const disposed: string[] = [];
  const host = new RuntimePluginHost({ runtime: "test" });
  await host.mount({ name: "first", start: () => ({ dispose: () => { disposed.push("first"); } }) });
  await host.mount({ name: "second", start: () => ({ dispose: () => { disposed.push("second"); } }) });
  assert.deepEqual(host.list(), ["first", "second"]);
  await host.dispose();
  assert.deepEqual(disposed, ["second", "first"]);
});

test("runtime plugin names cannot be mounted twice", async () => {
  const host = new RuntimePluginHost({ runtime: "test" });
  const plugin = { name: "same", start: () => ({ dispose() {} }) };
  await host.mount(plugin);
  await assert.rejects(() => host.mount(plugin), /already mounted/);
  await host.dispose();
});
