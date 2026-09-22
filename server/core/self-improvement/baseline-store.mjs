import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../file-state.mjs";
import { stableFingerprint } from "./candidate-schema.mjs";

const VERSION = 1;
const DEFAULT_HISTORY_LIMIT = 50;

export function createBaselineStore({ filePath, now = () => Date.now(), historyLimit = DEFAULT_HISTORY_LIMIT } = {}) {
  const state = { version: VERSION, current: null, history: [] };
  let loaded = false;

  async function load() {
    if (loaded) return snapshot();
    loaded = true;
    if (!filePath) return snapshot();
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      state.current = parsed?.current || null;
      state.history = Array.isArray(parsed?.history) ? parsed.history.slice(-historyLimit) : [];
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return snapshot();
  }

  async function capture({ root, query = {}, metrics = {} } = {}) {
    await load();
    const id = stableFingerprint({ root: root || null, query, metrics });
    if (state.current?.id === id) return { changed: false, baseline: state.current };
    const baseline = {
      id,
      root: root || null,
      query,
      metrics,
      captured_at: now()
    };
    state.current = baseline;
    state.history.push(baseline);
    if (state.history.length > historyLimit) state.history.splice(0, state.history.length - historyLimit);
    await persist();
    return { changed: true, baseline };
  }

  function snapshot() {
    return {
      version: VERSION,
      current: state.current,
      history: [...state.history]
    };
  }

  async function persist() {
    if (!filePath) return;
    await writeFileAtomic(filePath, Buffer.from(`${JSON.stringify(snapshot(), null, 2)}\n`, "utf8"));
  }

  return { load, capture, snapshot };
}
