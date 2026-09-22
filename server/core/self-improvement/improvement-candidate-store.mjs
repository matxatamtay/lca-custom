import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../file-state.mjs";
import { normalizeCandidate } from "./candidate-schema.mjs";

const VERSION = 1;

export function createImprovementCandidateStore({ jsonlPath, statePath, now = () => Date.now() } = {}) {
  const state = { version: VERSION, candidates: {} };
  let loaded = false;

  async function load() {
    if (loaded) return snapshot();
    loaded = true;
    if (!statePath) return snapshot();
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      state.candidates = parsed?.candidates && typeof parsed.candidates === "object" ? parsed.candidates : {};
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return snapshot();
  }

  async function ingest(inputs = []) {
    await load();
    const timestamp = now();
    const appended = [];
    let existing = 0;

    for (const input of inputs) {
      const candidate = normalizeCandidate(input);
      const current = state.candidates[candidate.fingerprint];
      if (current) {
        existing += 1;
        state.candidates[candidate.fingerprint] = {
          ...current,
          candidate,
          last_seen: timestamp,
          observations: Number(current.observations || 0) + 1
        };
        continue;
      }
      const entry = {
        candidate,
        status: "open",
        first_seen: timestamp,
        last_seen: timestamp,
        observations: 1
      };
      state.candidates[candidate.fingerprint] = entry;
      appended.push(entry);
    }

    if (appended.length && jsonlPath) {
      await mkdir(path.dirname(jsonlPath), { recursive: true });
      await appendFile(jsonlPath, appended.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
    }
    if (appended.length || existing) await persist();

    return {
      detected: inputs.length,
      added: appended.length,
      existing,
      total: Object.keys(state.candidates).length
    };
  }

  async function list({ category = null, status = "open", limit = 50 } = {}) {
    await load();
    const normalizedCategory = category ? String(category).trim().toUpperCase() : null;
    return Object.values(state.candidates)
      .filter((entry) => !status || entry.status === status)
      .filter((entry) => !normalizedCategory || entry.candidate?.category === normalizedCategory)
      .sort((left, right) => Number(right.last_seen || 0) - Number(left.last_seen || 0))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
      .map((entry) => ({
        ...entry.candidate,
        first_seen: entry.first_seen,
        last_seen: entry.last_seen,
        observations: entry.observations,
        status: entry.status
      }));
  }

  function snapshot() {
    return {
      version: VERSION,
      candidates: { ...state.candidates }
    };
  }

  async function persist() {
    if (!statePath) return;
    await writeFileAtomic(statePath, Buffer.from(`${JSON.stringify(snapshot(), null, 2)}\n`, "utf8"));
  }

  return { load, ingest, list, snapshot };
}
