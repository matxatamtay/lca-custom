import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./file-state.mjs";

const MAX_CHANGED_FILES = 120;
const MAX_FACTS = 80;
const MAX_EVENTS = 100;

export function createTaskStateCore(options) {
  const { TASK_PLAN_PATH, isoNow } = options;

  async function read() {
    try {
      const parsed = JSON.parse(await readFile(TASK_PLAN_PATH, "utf8"));
      return normalize(parsed);
    } catch {
      return null;
    }
  }

  async function create(goal, steps) {
    const now = isoNow();
    const state = normalize({
      version: 2,
      goal,
      status: "active",
      steps: (steps || []).map((text) => ({ text, done: false })),
      created: now,
      updated: now,
      changed_files: [],
      discoveries: [],
      decisions: [],
      blockers: [],
      last_verification: null,
      events: []
    });
    await write(state);
    return state;
  }

  async function update({ setStepDone, addSteps, status } = {}) {
    const state = await read();
    if (!state) return null;
    let changed = false;
    if (setStepDone !== undefined && state.steps[setStepDone] && !state.steps[setStepDone].done) {
      state.steps[setStepDone].done = true;
      changed = true;
    }
    if (Array.isArray(addSteps) && addSteps.length) {
      state.steps.push(...addSteps.filter(Boolean).map((text) => ({ text: String(text), done: false })));
      changed = true;
    }
    if (status !== undefined && String(status) !== state.status) {
      state.status = String(status);
      changed = true;
    }
    if (changed) {
      state.updated = isoNow();
      state.events = pushBounded(state.events, { type: "task_update", at: state.updated }, MAX_EVENTS);
      await write(state);
    }
    return state;
  }

  async function recordEdit(files, { tool = "edit" } = {}) {
    return mutate((state) => {
      state.changed_files = dedupeBounded([...state.changed_files, ...(files || []).map(String)], MAX_CHANGED_FILES);
      state.events = pushBounded(state.events, {
        type: "edit",
        at: isoNow(),
        tool,
        files: dedupeBounded((files || []).map(String), 30)
      }, MAX_EVENTS);
    });
  }

  async function recordDiscovery(text, refs = []) {
    const value = compactText(text);
    if (!value) return read();
    return mutate((state) => {
      state.discoveries = pushFact(state.discoveries, { text: value, refs: dedupeBounded(refs.map(String), 20), at: isoNow() });
      state.events = pushBounded(state.events, { type: "discovery", at: isoNow(), text: value.slice(0, 240) }, MAX_EVENTS);
    });
  }

  async function recordDecision(decision, why) {
    const value = compactText(decision);
    if (!value) return read();
    return mutate((state) => {
      state.decisions = pushFact(state.decisions, { decision: value, why: compactText(why), at: isoNow() });
      state.events = pushBounded(state.events, { type: "decision", at: isoNow(), decision: value.slice(0, 240) }, MAX_EVENTS);
    });
  }

  async function recordBlocker(text, refs = []) {
    const value = compactText(text);
    if (!value) return read();
    return mutate((state) => {
      state.blockers = pushFact(state.blockers, { text: value, refs: dedupeBounded(refs.map(String), 20), at: isoNow() });
      state.events = pushBounded(state.events, { type: "blocker", at: isoNow(), text: value.slice(0, 240) }, MAX_EVENTS);
    });
  }

  async function recordVerification(result, { tool = "quality_gate" } = {}) {
    const summary = compactVerification(result, tool, isoNow());
    return mutate((state) => {
      state.last_verification = summary;
      state.events = pushBounded(state.events, {
        type: "verification",
        at: summary.at,
        tool,
        ok: summary.ok,
        failed: summary.failed
      }, MAX_EVENTS);
    });
  }

  async function mutate(mutator) {
    const state = await read();
    if (!state) return null;
    mutator(state);
    state.updated = isoNow();
    await write(state);
    return state;
  }

  async function write(state) {
    await mkdir(path.dirname(TASK_PLAN_PATH), { recursive: true });
    await writeFileAtomic(TASK_PLAN_PATH, Buffer.from(`${JSON.stringify(normalize(state), null, 2)}\n`, "utf8"));
  }

  return {
    create,
    read,
    update,
    recordEdit,
    recordDiscovery,
    recordDecision,
    recordBlocker,
    recordVerification
  };
}

function normalize(value) {
  const now = value?.updated || value?.created || null;
  return {
    version: 2,
    goal: String(value?.goal || ""),
    status: String(value?.status || "active"),
    steps: Array.isArray(value?.steps) ? value.steps.map((step) => ({
      text: String(typeof step === "string" ? step : step?.text || ""),
      done: Boolean(typeof step === "object" && step?.done)
    })).filter((step) => step.text) : [],
    created: value?.created || now,
    updated: value?.updated || now,
    changed_files: dedupeBounded(Array.isArray(value?.changed_files) ? value.changed_files.map(String) : [], MAX_CHANGED_FILES),
    discoveries: boundedFacts(value?.discoveries),
    decisions: boundedFacts(value?.decisions),
    blockers: boundedFacts(value?.blockers),
    last_verification: value?.last_verification && typeof value.last_verification === "object" ? value.last_verification : null,
    events: Array.isArray(value?.events) ? value.events.slice(-MAX_EVENTS) : []
  };
}

function boundedFacts(value) {
  return Array.isArray(value) ? value.slice(-MAX_FACTS) : [];
}

function pushFact(items, item) {
  const key = JSON.stringify(item);
  const withoutDuplicate = items.filter((entry) => JSON.stringify(entry) !== key);
  return [...withoutDuplicate, item].slice(-MAX_FACTS);
}

function pushBounded(items, item, limit) {
  return [...(Array.isArray(items) ? items : []), item].slice(-limit);
}

function dedupeBounded(values, limit) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.slice(-limit);
}

function compactText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 1200);
}

function compactVerification(result, tool, at) {
  const gates = Array.isArray(result?.gates)
    ? result.gates.slice(0, 12).map((gate) => ({ name: gate.name, status: gate.status, ok: gate.ok }))
    : [];
  return {
    at,
    tool,
    ok: Boolean(result?.ok),
    failed: Number(result?.failed || (result?.ok === false ? 1 : 0)),
    ran: Number(result?.ran || gates.filter((gate) => gate.status === "pass" || gate.status === "fail").length),
    gates
  };
}
