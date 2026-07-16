import assert from "node:assert/strict";
import test from "node:test";
import {
  BridgeClientMessageSchema,
  BrowserActionSchema,
  CaptureOptionsSchema,
  ElementTargetSchema,
  NavigationOptionsSchema,
  PROTOCOL_VERSION
} from "../packages/protocol/src/index.js";

test("capture options apply secure defaults", () => {
  const options = CaptureOptionsSchema.parse({});
  assert.equal(options.target, "active");
  assert.equal(options.bodyPolicy, "none");
  assert.equal(options.redact, true);
  assert.equal(options.dom, "interactive");
  assert.equal(options.styleMode, "essential");
  assert.equal(options.maxHtmlChars, 8_000_000);
  assert.ok(options.include.includes("screenshot"));
  assert.ok(options.include.includes("visual"));
  assert.equal(options.include.includes("html"), false);
});

test("browser control schemas apply bounded defaults", () => {
  const action = BrowserActionSchema.parse({ kind: "click", element: { selector: "#save" } });
  assert.equal(action.kind, "click");
  if (action.kind === "click") assert.equal(action.clickCount, 1);
  const navigation = NavigationOptionsSchema.parse({ url: "/settings" });
  assert.equal(navigation.target, "active");
  assert.equal(navigation.waitUntil, "load");
  assert.equal(navigation.captureAfter, true);
});

test("element target requires a complete targeting strategy", () => {
  assert.throws(() => ElementTargetSchema.parse({}));
  assert.throws(() => ElementTargetSchema.parse({ x: 10 }));
  assert.deepEqual(ElementTargetSchema.parse({ role: "button", name: "Save" }), { role: "button", name: "Save" });
});

test("bridge protocol rejects unsupported versions", () => {
  assert.throws(() => BridgeClientMessageSchema.parse({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION + 1,
    extensionId: "a".repeat(32),
    extensionVersion: "0.1.0",
    capabilities: []
  }));
});

test("pairing messages require a six-digit code", () => {
  assert.throws(() => BridgeClientMessageSchema.parse({
    type: "pair",
    requestId: "req",
    code: "123",
    extensionId: "a".repeat(32)
  }));
});
