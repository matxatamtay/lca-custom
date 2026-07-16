import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PairingManager } from "../apps/server/src/security/pairing.js";

const extensionId = "a".repeat(32);
const origin = `chrome-extension://${extensionId}`;

function managerForTest(): PairingManager {
  return new PairingManager(path.join(os.tmpdir(), `lba-pairing-${randomUUID()}.json`));
}

test("pairing code is one-time and token is bound to extension origin", () => {
  const manager = managerForTest();
  const first = manager.currentCode();
  const paired = manager.pair(first.code, extensionId, origin);
  assert.ok(paired.token.length >= 20);
  assert.ok(manager.authenticate(paired.token, extensionId, origin));
  assert.equal(manager.authenticate(paired.token, "b".repeat(32), `chrome-extension://${"b".repeat(32)}`), null);
  assert.throws(() => manager.pair(first.code, extensionId, origin), /Invalid or expired pairing code/);
});

test("pairing rejects an extension id that does not match the websocket origin", () => {
  const manager = managerForTest();
  const current = manager.currentCode();
  assert.throws(() => manager.pair(current.code, extensionId, `chrome-extension://${"b".repeat(32)}`), /does not match/);
});

test("revoked sessions cannot authenticate", () => {
  const manager = managerForTest();
  const paired = manager.pair(manager.currentCode().code, extensionId, origin);
  assert.equal(manager.revoke(paired.sessionId), true);
  assert.equal(manager.authenticate(paired.token, extensionId, origin), null);
});

test("pairing is temporarily blocked after repeated invalid codes", () => {
  const manager = managerForTest();
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.throws(() => manager.pair("999999", extensionId, origin), /Invalid or expired pairing code/);
  }
  assert.throws(() => manager.pair(manager.currentCode().code, extensionId, origin), /temporarily blocked/);
});
