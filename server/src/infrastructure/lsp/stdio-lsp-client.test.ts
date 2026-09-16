import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StdioLspClient } from "./stdio-lsp-client.js";

test("stdio LSP client frames requests, responses, and notifications", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-lsp-client-"));
  const script = path.join(root, "mock-lsp.cjs");
  await writeFile(script, String.raw`
let buffer = Buffer.alloc(0);
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString();
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + length));
    buffer = buffer.subarray(bodyStart + length);
    if (message.method === 'ping') {
      send({ jsonrpc: '2.0', method: 'test/ready', params: { ok: true } });
      send({ jsonrpc: '2.0', id: message.id, result: { pong: message.params } });
    } else if (message.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: message.id, result: null });
    } else if (message.method === 'exit') {
      process.exit(0);
    }
  }
});
`, "utf8");

  const client = new StdioLspClient({ command: process.execPath, args: [script], cwd: root, requestTimeoutMs: 1_000 });
  let notification: unknown;
  const unsubscribe = client.onNotification((method, params) => {
    if (method === "test/ready") notification = params;
  });

  try {
    const result = await client.request("ping", { value: 7 });
    assert.deepEqual(result, { pong: { value: 7 } });
    assert.deepEqual(notification, { ok: true });
  } finally {
    unsubscribe();
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
