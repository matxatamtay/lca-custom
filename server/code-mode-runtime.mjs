import { Worker } from "node:worker_threads";
import { transformSync } from "esbuild";

const DEFAULT_WALL_MS = 120_000;
const DEFAULT_HEAP_MB = 256;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const pending = new Map();
let nextId = 1;
const logs = [];
const call = (facade, action, args = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  parentPort.postMessage({ type: 'call', id, facade, action, args });
});
parentPort.on('message', (message) => {
  if (!message || message.type !== 'result') return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) waiter.resolve(message.value);
  else waiter.reject(new Error(message.error || 'LCA binding failed'));
});
const lca = Object.freeze({
  search: (action, args) => call('workspace_search', action, args),
  read: (action, args) => call('workspace_read', action, args),
  edit: (action, args) => call('workspace_edit', action, args),
  exec: (action, args) => call('workspace_exec', action, args),
  git: (action, args) => call('workspace_git', action, args),
  verify: (action, args) => call('workspace_verify', action, args),
  status: (action, args) => call('workspace_status', action, args),
  agent: (action, args) => call('workspace_agent', action, args),
  ui: (action, args) => call('workspace_ui', action, args)
});
const safeConsole = Object.freeze({
  log: (...items) => { if (logs.length < 200) logs.push(items.map(String).join(' ')); },
  error: (...items) => { if (logs.length < 200) logs.push(items.map(String).join(' ')); }
});
Promise.resolve().then(() => {
  const factory = new Function('lca', 'console', workerData.compiled + '\nreturn globalThis.__lca_run(lca, console);');
  return factory(lca, safeConsole);
}).then((value) => parentPort.postMessage({ type: 'done', value, logs }))
  .catch((error) => parentPort.postMessage({ type: 'error', error: error?.stack || error?.message || String(error), logs }));
`;

export async function runCodeMode({ program, dispatch, wallMs = DEFAULT_WALL_MS, heapMb = DEFAULT_HEAP_MB, signal }) {
  if (typeof program !== "string" || !program.trim()) throw new Error("Code Mode requires a non-empty TypeScript program body.");
  if (typeof dispatch !== "function") throw new Error("Code Mode requires a host dispatch function.");
  const compiled = compileProgram(program);
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { compiled },
    resourceLimits: { maxOldGenerationSizeMb: Math.max(64, Math.min(1024, Number(heapMb) || DEFAULT_HEAP_MB)) }
  });
  const timeoutMs = Math.max(1000, Math.min(600_000, Number(wallMs) || DEFAULT_WALL_MS));
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = async (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      await worker.terminate().catch(() => undefined);
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`Code Mode exceeded ${timeoutMs} ms wall time.`)), timeoutMs);
    timer.unref?.();
    const onAbort = () => finish(reject, new Error("Code Mode aborted."));
    signal?.addEventListener?.("abort", onAbort, { once: true });
    worker.on("message", async (message) => {
      if (message?.type === "call") {
        try {
          const value = await dispatch(message.facade, message.action, message.args || {});
          worker.postMessage({ type: "result", id: message.id, ok: true, value });
        } catch (error) {
          worker.postMessage({ type: "result", id: message.id, ok: false, error: error?.message || String(error) });
        }
        return;
      }
      if (message?.type === "done") {
        try {
          const bytes = Buffer.byteLength(JSON.stringify(message.value ?? null));
          if (bytes > MAX_OUTPUT_BYTES) throw new Error(`Code Mode result exceeded ${MAX_OUTPUT_BYTES} bytes.`);
          await finish(resolve, { value: message.value ?? null, logs: message.logs || [], output_bytes: bytes });
        } catch (error) {
          await finish(reject, error);
        }
      } else if (message?.type === "error") {
        await finish(reject, new Error(message.error || "Code Mode worker failed."));
      }
    });
    worker.once("error", (error) => finish(reject, error));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) void finish(reject, new Error(`Code Mode worker exited with code ${code}.`));
    });
  });
}

function compileProgram(program) {
  const source = `globalThis.__lca_run = async (lca, console) => {\n${program}\n};`;
  return transformSync(source, { loader: "ts", target: "es2022", format: "iife" }).code;
}
