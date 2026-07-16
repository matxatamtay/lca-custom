import assert from "node:assert/strict";
import test from "node:test";
import { redactDeep, redactHeaders, redactUrl } from "../apps/server/src/security/redaction.js";

test("redacts sensitive query values and removes fragments", () => {
  const value = redactUrl("https://example.test/path?token=secret123&view=full#private");
  assert.match(value, /token=%5Bredacted%5D/);
  assert.match(value, /view=full/);
  assert.ok(!value.includes("#private"));
});

test("redacts authorization and cookie headers", () => {
  const headers = redactHeaders([
    { name: "Authorization", value: "Bearer abcdefghijklmnop" },
    { name: "Cookie", value: "session=secret" },
    { name: "Accept", value: "application/json" }
  ]) as Array<{ name: string; value: string }>;
  assert.equal(headers[0]?.value, "[redacted]");
  assert.equal(headers[1]?.value, "[redacted]");
  assert.equal(headers[2]?.value, "application/json");
});

test("redacts bodies, tokens, password values, and secret-looking console strings", () => {
  const safe = redactDeep({
    postData: "password=secret",
    message: "request failed with Bearer abcdefghijklmnop and sk-abcdefghijklmno",
    input: { type: "password", value: "hunter2" },
    requestHeaders: [{ name: "Cookie", value: "a=b" }]
  }) as any;
  assert.equal(safe.postData, "[redacted]");
  assert.equal(safe.input.value, "[redacted]");
  assert.ok(!safe.message.includes("abcdefghijklmnop"));
  assert.equal(safe.requestHeaders[0].value, "[redacted]");
});

test("redacts accessibility values for editable roles", () => {
  const safe = redactDeep({
    nodeId: "1",
    role: { type: "role", value: "textbox" },
    value: { type: "string", value: "private text" }
  }) as any;
  assert.equal(safe.value, "[redacted]");
});
