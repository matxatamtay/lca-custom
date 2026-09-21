import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./file-state.mjs";

const VERSION = 2;
const DEFAULT_MAX_TRACES = 100;

export function classifyTelemetryTask(task) {
  const text = String(task || "").trim();
  if (!text) return "unknown";
  if (/(?:^|[\s;:()[\]{}])(?:LIVE_|BENCH_)/i.test(text)
    || /\b(?:LIVE synthetic|synthetic smoke|live smoke(?: test)?|benchmark daemon|smoke test the restarted|disposable benchmark)\b/i.test(text)) return "synthetic";
  if (/(?:implement|review)\s+M\d+/i.test(text) && /lca-custom|M\d+/i.test(text)) return "internal";
  return "user";
}

export function telemetryPathCandidates(args, result) {
  const structured = result?.structuredContent && typeof result.structuredContent === "object"
    ? result.structuredContent
    : null;
  const nested = args?.arguments && typeof args.arguments === "object" ? args.arguments : {};
  const operation = Array.isArray(nested.operations) ? nested.operations[0] : null;
  const directOperation = Array.isArray(args?.operations) ? args.operations[0] : null;
  return [
    structured?.project_resolution?.workspace_root,
    structured?.workspace_root,
    structured?.root,
    args?.path, args?.cwd, args?.root,
    nested.path, nested.cwd, nested.root, nested.from, nested.to,
    operation?.path, operation?.rename_to,
    directOperation?.path, directOperation?.rename_to,
    Array.isArray(nested.paths) ? nested.paths[0] : null,
    Array.isArray(args?.changed_files) ? args.changed_files[0] : null,
    Array.isArray(nested.changed_files) ? nested.changed_files[0] : null
  ].filter((value) => typeof value === "string" && value.trim());
}

export function modelVisibleResultBytes(result) {
  try {
    return Buffer.byteLength(JSON.stringify({
      content: result?.content ?? [],
      structuredContent: result?.structuredContent ?? null
    }), "utf8");
  } catch {
    return 0;
  }
}

export function createPerformanceTelemetry(options = {}) {
  const {
    filePath = null,
    now = () => Date.now(),
    createId = () => randomUUID(),
    maxTraces = DEFAULT_MAX_TRACES
  } = options;

  const state = {
    version: VERSION,
    traces: [],
    active_by_root: {},
    last_error: null
  };
  let flushTimer = null;
  let flushPromise = null;

  async function load() {
    if (!filePath) return snapshot();
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      state.traces = Array.isArray(parsed?.traces)
        ? parsed.traces.slice(-maxTraces).map((trace) => ({
            ...trace,
            task_class: classifyTelemetryTask(trace?.task)
          }))
        : [];
      state.active_by_root = parsed?.active_by_root && typeof parsed.active_by_root === "object"
        ? { ...parsed.active_by_root }
        : {};
      state.last_error = null;
      pruneDanglingActive();
    } catch (error) {
      if (error?.code !== "ENOENT") state.last_error = String(error?.message || error).slice(0, 1000);
    }
    return snapshot();
  }

  function recordToolCall(input) {
    const {
      tool,
      action = null,
      root,
      task = null,
      success = true,
      durationMs = 0,
      inChars = 0,
      outChars = 0,
      result = null
    } = input || {};
    if (!tool || !root) return null;

    const timestamp = now();
    let trace;
    if (tool === "workspace_context") {
      const previousId = state.active_by_root[root];
      const previous = findTrace(previousId);
      if (previous && !previous.ended_at) previous.ended_at = timestamp;
      trace = createTrace({ root, task, timestamp, taskClass: input?.taskClass });
      state.traces.push(trace);
      state.active_by_root[root] = trace.task_id;
      trimTraces();
    } else {
      trace = findTrace(state.active_by_root[root]);
      if (!trace) return null;
    }

    trace.last_at = timestamp;
    trace.tool_roundtrips += 1;
    trace.input_chars += Math.max(0, Number(inChars) || 0);
    trace.bytes_to_model += Math.max(0, Number(outChars) || 0);
    if (!success) trace.failures += 1;

    const label = action ? `${tool}:${action}` : tool;
    const timing = trace.tools[label] || { calls: 0, total_ms: 0, max_ms: 0 };
    timing.calls += 1;
    timing.total_ms = roundMs(timing.total_ms + durationMs);
    timing.max_ms = roundMs(Math.max(timing.max_ms, durationMs));
    trace.tools[label] = timing;

    const cache = countCacheSignals(structured(result));
    if (tool === "workspace_context") {
      trace.context_ms = roundMs(durationMs);
      trace.context_temperature = classifyContextTemperature(cache);
      const contextRoot = structured(result)?.project_resolution?.active_project_root;
      if (typeof contextRoot === "string" && contextRoot.trim()) trace.context_root = contextRoot;
      const coverage = structured(result)?.coverage;
      if (coverage && typeof coverage === "object") {
        trace.providers = Object.fromEntries(Object.entries(coverage).map(([provider, value]) => [provider, {
          status: value?.status || "unknown",
          hits: Number(value?.hits || 0),
          latency_ms: roundMs(value?.latencyMs || 0)
        }]));
      }
      const ranking = structured(result)?.ranking;
      if (ranking && typeof ranking === "object") {
        trace.ranking = compactRanking(ranking);
      }
    }
    if (tool === "workspace_search") trace.searches += 1;
    if (tool === "workspace_read") trace.reads += 1;
    if (tool === "workspace_edit") {
      trace.edits += 1;
      if (isPatchAction(action)) {
        trace.patches += 1;
        const fusedVerificationMs = Number(structured(result)?.verification?.duration_ms || 0);
        trace.verification_ms = roundMs(trace.verification_ms + Math.max(0, fusedVerificationMs));
        trace.patch_ms = roundMs(trace.patch_ms + Math.max(0, durationMs - fusedVerificationMs));
      }
    }
    if (tool === "workspace_verify") {
      trace.verifications += 1;
      trace.verification_ms = roundMs(trace.verification_ms + durationMs);
    }

    trace.cache_hits += cache.hits;
    trace.cache_checks += cache.checks;
    scheduleFlush();
    return compactTrace(trace);
  }

  function snapshot() {
    const active = Object.entries(state.active_by_root)
      .map(([root, id]) => findTrace(id) ? compactTrace(findTrace(id)) : null)
      .filter(Boolean);
    const recent = state.traces.slice(-10).map(compactTrace);
    return {
      version: VERSION,
      active,
      aggregate: aggregateTraces(state.traces),
      workload: workloadSummary(state.traces),
      recent,
      persisted: Boolean(filePath),
      ...(state.last_error ? { last_error: state.last_error } : {})
    };
  }

  async function flush() {
    if (!filePath) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      try {
        await mkdir(path.dirname(filePath), { recursive: true });
        const payload = {
          version: VERSION,
          active_by_root: state.active_by_root,
          traces: state.traces.slice(-maxTraces)
        };
        await writeFileAtomic(filePath, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8"));
        state.last_error = null;
      } catch (error) {
        state.last_error = String(error?.message || error).slice(0, 1000);
      } finally {
        flushPromise = null;
      }
    })();
    return flushPromise;
  }

  async function close() {
    await flush();
  }

  function scheduleFlush() {
    if (!filePath || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, 250);
    flushTimer.unref?.();
  }

  function createTrace({ root, task, timestamp, taskClass }) {
    const normalizedTask = String(task || "").trim().slice(0, 500);
    return {
      task_id: `task-${createId()}`,
      root,
      task: normalizedTask,
      task_class: taskClass || classifyTelemetryTask(normalizedTask),
      context_temperature: "unknown",
      context_root: null,
      started_at: timestamp,
      last_at: timestamp,
      ended_at: null,
      tool_roundtrips: 0,
      input_chars: 0,
      bytes_to_model: 0,
      context_ms: 0,
      searches: 0,
      reads: 0,
      edits: 0,
      patches: 0,
      verifications: 0,
      patch_ms: 0,
      verification_ms: 0,
      failures: 0,
      cache_hits: 0,
      cache_checks: 0,
      providers: {},
      ranking: null,
      tools: {}
    };
  }

  function findTrace(id) {
    if (!id) return null;
    for (let index = state.traces.length - 1; index >= 0; index -= 1) {
      if (state.traces[index]?.task_id === id) return state.traces[index];
    }
    return null;
  }

  function trimTraces() {
    while (state.traces.length > maxTraces) state.traces.shift();
    pruneDanglingActive();
  }

  function pruneDanglingActive() {
    const ids = new Set(state.traces.map((trace) => trace.task_id));
    for (const [root, id] of Object.entries(state.active_by_root)) {
      if (!ids.has(id)) delete state.active_by_root[root];
    }
  }

  function taskClassMap() {
    return Object.fromEntries(state.traces
      .filter((trace) => trace?.task_id)
      .map((trace) => [trace.task_id, classifyTelemetryTask(trace.task)]));
  }

  return { load, recordToolCall, snapshot, taskClassMap, flush, close };
}

function structured(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const first = Array.isArray(result?.content)
    ? result.content.find((item) => item?.type === "text" && typeof item?.text === "string")?.text
    : null;
  if (typeof first === "string") {
    const text = first.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") return parsed;
      } catch {
        // Compact facades are allowed to return ordinary non-JSON text.
      }
    }
  }
  return result && typeof result === "object" ? result : {};
}

function compactTrace(trace) {
  const elapsedMs = Math.max(0, Number((trace.ended_at || trace.last_at || trace.started_at) - trace.started_at) || 0);
  return {
    task_id: trace.task_id,
    root: trace.root,
    task: trace.task,
    task_class: trace.task_class || classifyTelemetryTask(trace.task),
    context_temperature: trace.context_temperature || "unknown",
    ...(trace.context_root ? { context_root: trace.context_root } : {}),
    started_at: trace.started_at,
    last_at: trace.last_at,
    ...(trace.ended_at ? { ended_at: trace.ended_at } : {}),
    elapsed_ms: elapsedMs,
    tool_roundtrips: trace.tool_roundtrips,
    bytes_to_model: trace.bytes_to_model,
    context_ms: trace.context_ms,
    searches: trace.searches || 0,
    reads: trace.reads,
    edits: trace.edits,
    patches: trace.patches,
    verifications: trace.verifications,
    patch_ms: roundMs(trace.patch_ms),
    verification_ms: roundMs(trace.verification_ms),
    failures: trace.failures,
    cache: {
      hits: trace.cache_hits,
      checks: trace.cache_checks,
      hit_ratio: trace.cache_checks ? roundRatio(trace.cache_hits / trace.cache_checks) : null
    },
    providers: trace.providers,
    ...(trace.ranking ? { ranking: trace.ranking } : {}),
    tools: trace.tools
  };
}

function aggregateTraces(traces) {
  if (!traces.length) return { tasks: 0, avg_roundtrips: 0, avg_context_ms: 0, avg_bytes_to_model: 0, cache_hit_ratio: null };
  const sum = (key) => traces.reduce((total, trace) => total + (Number(trace[key]) || 0), 0);
  const cacheHits = sum("cache_hits");
  const cacheChecks = sum("cache_checks");
  return {
    tasks: traces.length,
    avg_roundtrips: roundRatio(sum("tool_roundtrips") / traces.length),
    avg_context_ms: roundMs(sum("context_ms") / traces.length),
    avg_bytes_to_model: Math.round(sum("bytes_to_model") / traces.length),
    avg_searches: roundRatio(sum("searches") / traces.length),
    avg_patch_ms: roundMs(sum("patch_ms") / traces.length),
    avg_verification_ms: roundMs(sum("verification_ms") / traces.length),
    context_ms: percentileSummary(traces.map((trace) => trace.context_ms)),
    elapsed_ms: percentileSummary(traces.map((trace) => Math.max(0, Number((trace.ended_at || trace.last_at || trace.started_at) - trace.started_at) || 0))),
    roundtrips: percentileSummary(traces.map((trace) => trace.tool_roundtrips)),
    cache_hit_ratio: cacheChecks ? roundRatio(cacheHits / cacheChecks) : null,
    jev: rankingSummary(traces)
  };
}

function workloadSummary(traces) {
  const counts = { user: 0, internal: 0, synthetic: 0, unknown: 0 };
  const temperatures = { cold: 0, mixed: 0, warm: 0, unknown: 0 };
  for (const trace of traces) {
    const taskClass = trace.task_class || classifyTelemetryTask(trace.task);
    counts[taskClass] = (counts[taskClass] || 0) + 1;
    const temperature = trace.context_temperature || "unknown";
    temperatures[temperature] = (temperatures[temperature] || 0) + 1;
  }
  const user = traces.filter((trace) => (trace.task_class || classifyTelemetryTask(trace.task)) === "user");
  return {
    classes: counts,
    context_temperature: temperatures,
    user_tasks: {
      samples: user.length,
      context_ms: percentileSummary(user.map((trace) => trace.context_ms)),
      roundtrips: percentileSummary(user.map((trace) => trace.tool_roundtrips)),
      bytes_to_model: percentileSummary(user.map((trace) => trace.bytes_to_model)),
      jev: rankingSummary(user)
    }
  };
}

function compactRanking(ranking) {
  return {
    provider: ["jev", "rule"].includes(ranking?.provider) ? ranking.provider : "rule",
    status: ["applied", "fallback", "skipped"].includes(ranking?.status) ? ranking.status : "fallback",
    latency_ms: roundMs(ranking?.latencyMs),
    candidates: boundedCount(ranking?.candidates),
    accepted: boundedCount(ranking?.accepted),
    pruned: boundedCount(ranking?.pruned),
    ...( ["insufficient", "partial", "sufficient"].includes(ranking?.sufficiency)
      ? { sufficiency: ranking.sufficiency, sufficiency_confidence: roundRatio(ranking?.sufficiencyConfidence) }
      : {}),
    ...(ranking?.fallbackReason ? { fallback_reason: String(ranking.fallbackReason).slice(0, 80) } : {})
  };
}

function rankingSummary(traces) {
  const rankings = traces.map((trace) => trace?.ranking).filter(Boolean);
  const applied = rankings.filter((ranking) => ranking.provider === "jev" && ranking.status === "applied");
  const sufficiency = { insufficient: 0, partial: 0, sufficient: 0 };
  for (const ranking of applied) {
    if (ranking.sufficiency in sufficiency) sufficiency[ranking.sufficiency] += 1;
  }
  const totalPruned = applied.reduce((sum, ranking) => sum + boundedCount(ranking.pruned), 0);
  return {
    samples: rankings.length,
    applied: applied.length,
    fallback: rankings.filter((ranking) => ranking.status === "fallback").length,
    skipped: rankings.filter((ranking) => ranking.status === "skipped").length,
    sufficiency,
    avg_latency_ms: applied.length ? roundMs(applied.reduce((sum, ranking) => sum + Number(ranking.latency_ms || 0), 0) / applied.length) : 0,
    total_pruned: totalPruned,
    avg_pruned: applied.length ? roundRatio(totalPruned / applied.length) : 0
  };
}

function boundedCount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function classifyContextTemperature(cache) {
  if (!cache?.checks) return "unknown";
  const ratio = cache.hits / cache.checks;
  if (ratio >= 0.75) return "warm";
  if (ratio <= 0.1) return "cold";
  return "mixed";
}

function percentileSummary(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return { p50: 0, p95: 0 };
  return { p50: roundMs(percentile(sorted, 0.5)), p95: roundMs(percentile(sorted, 0.95)) };
}

function percentile(sorted, ratio) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function countCacheSignals(value) {
  let hits = 0;
  let checks = 0;
  const seen = new Set();
  const visit = (node, depth) => {
    if (depth > 6 || !node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 100)) visit(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(node)) {
      if ((key === "cache_hit" || key === "prefetch_hit") && typeof item === "boolean") {
        checks += 1;
        if (item) hits += 1;
      } else if (key === "cached" && typeof item === "boolean") {
        checks += 1;
        if (item) hits += 1;
      }
      if (item && typeof item === "object") visit(item, depth + 1);
    }
  };
  visit(value, 0);
  return { hits, checks };
}

function isPatchAction(action) {
  return ["apply_patch", "patch", "write_file", "write", "replace_in_file", "replace", "move_path", "delete_path"].includes(String(action || ""));
}

function roundMs(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function roundRatio(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}
