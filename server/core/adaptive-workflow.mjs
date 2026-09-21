export function buildAdaptiveWorkflow(options = {}) {
  const {
    intent,
    task = "",
    evidence = [],
    coverage = {},
    ranking = null,
    likelyReads = [],
    verification = null,
    performance = null,
    root = null
  } = options;

  const resolvedIntent = inferAdaptiveIntent(task, intent);
  const telemetry = performanceProfile(performance, root, 8, task);
  const evidenceCount = Array.isArray(evidence) ? evidence.length : 0;
  const filesystemHits = Number(coverage?.filesystem?.hits || 0);
  const semanticReady = coverage?.semantic?.status === "ok";
  const hasLikelyReads = Array.isArray(likelyReads) && likelyReads.length > 0;
  const hasVerification = Boolean(verification && Array.isArray(verification.gates));
  const reasons = [];
  const calls = [];
  const jevApplied = ranking?.provider === "jev" && ranking?.status === "applied";
  const sufficiency = jevApplied ? ranking?.sufficiency : null;
  const loopGuardActive = telemetry.same_task_contexts > 0 && telemetry.same_task_edits === 0;
  const repeatedReads = loopGuardActive && telemetry.same_task_reads > 0;
  const repeatedSearches = loopGuardActive && telemetry.same_task_searches > 0;
  if (jevApplied && sufficiency) reasons.push(`jev:sufficiency:${sufficiency}`);
  if (loopGuardActive) reasons.push(`loop:repeat-task:${telemetry.same_task_contexts}`);

  if (telemetry.samples > 0) {
    if (telemetry.avg_roundtrips >= 6) reasons.push(`telemetry:high-roundtrips:${telemetry.avg_roundtrips}`);
    if (telemetry.avg_searches >= 4) reasons.push(`telemetry:batch-searches:${telemetry.avg_searches}`);
    if (telemetry.avg_edits >= 4) reasons.push(`telemetry:batch-edits:${telemetry.avg_edits}`);
    if (telemetry.avg_reads >= 3) reasons.push(`telemetry:avoid-extra-reads:${telemetry.avg_reads}`);
  }

  if (resolvedIntent === "review") {
    reasons.push("intent:review");
    calls.push({ tool: "workspace_verify", action: "review", reason: "review the current diff before opening more files" });
    if (hasLikelyReads) calls.push(readCall(likelyReads, "open only the highest-signal files if review findings need source context"));
    return result("review_first", calls, reasons, telemetry, 2);
  }

  if (resolvedIntent === "understand") {
    reasons.push("intent:understand");
    if (sufficiency === "sufficient") {
      return result("context_ready", calls, reasons, telemetry, 1);
    }
    if (sufficiency === "partial" && repeatedReads) {
      reasons.push("loop:avoid-repeat-read");
      return result("context_ready", calls, reasons, telemetry, 1);
    }
    if (sufficiency === "insufficient") {
      if (repeatedSearches) {
        if (hasLikelyReads && !repeatedReads) {
          reasons.push("loop:avoid-repeat-search");
          calls.push(readCall(likelyReads, "broad retrieval already ran for this unchanged task; inspect only the strongest remaining targets"));
          return result("inspect_first", calls, reasons, telemetry, 1);
        }
        reasons.push("loop:retrieval-exhausted");
        return result("context_stalled", calls, reasons, telemetry, 1);
      }
      calls.push({ tool: "workspace_search", action: "text", reason: "Jev says current context is insufficient; broaden retrieval before reading files" });
      return result("retrieve_more", calls, reasons, telemetry, 1);
    }
    if (hasLikelyReads) calls.push(readCall(likelyReads, "read the cited source slices/files instead of broad repository reads"));
    else calls.push({ tool: "workspace_search", action: "symbols", reason: "context has no confident file target yet" });
    return result("inspect_first", calls, reasons, telemetry, 1);
  }

  const highSignal = evidenceCount >= 3 && filesystemHits > 0 && hasLikelyReads;
  const lowSignal = evidenceCount < 3 || filesystemHits === 0;

  if ((resolvedIntent === "implement" || resolvedIntent === "refactor") && sufficiency === "insufficient") {
    if (repeatedSearches) {
      if (hasLikelyReads && !repeatedReads) {
        reasons.push("loop:avoid-repeat-search");
        calls.push(readCall(likelyReads, "broad retrieval already ran for this unchanged task; inspect the strongest concrete targets before deciding whether to edit"));
        return result("inspect_first", calls, reasons, telemetry, 1);
      }
      reasons.push("loop:retrieval-exhausted");
      return result("context_stalled", calls, reasons, telemetry, 1);
    }
    calls.push({ tool: "workspace_search", action: "text", reason: "Jev says current context is insufficient; locate a stronger implementation target before editing" });
    reasons.push("jev:retrieve-before-edit");
    return result("retrieve_more", calls, reasons, telemetry, 1);
  }

  if ((resolvedIntent === "implement" || resolvedIntent === "refactor") && sufficiency === "partial") {
    if (repeatedReads && highSignal) {
      reasons.push("loop:avoid-repeat-read");
      calls.push(batchEditCall(hasVerification));
      return result("fast_path", calls, reasons, telemetry, 1);
    }
    if (hasLikelyReads) {
      calls.push(readCall(likelyReads, "Jev says context is partial; inspect only the highest-signal targets before editing"));
    } else {
      calls.push({ tool: "workspace_search", action: "text", reason: "Jev says context is partial and no concrete file target is available" });
    }
    calls.push(batchEditCall(hasVerification));
    reasons.push("jev:targeted-confirmation");
    return result("inspect_first", calls, reasons, telemetry, 2);
  }

  if ((resolvedIntent === "implement" || resolvedIntent === "refactor") && highSignal) {
    reasons.push(`evidence:high-signal:${evidenceCount}`);
    if (semanticReady) reasons.push("semantic:ready");
    calls.push(batchEditCall(hasVerification));
    return result("fast_path", calls, reasons, telemetry, 1);
  }

  if (resolvedIntent === "debug" || lowSignal) {
    reasons.push(resolvedIntent === "debug" ? "intent:debug" : `evidence:low-signal:${evidenceCount}`);
    if (repeatedReads && highSignal) {
      reasons.push("loop:avoid-repeat-read");
      calls.push(batchEditCall(hasVerification));
      return result("fast_path", calls, reasons, telemetry, 1);
    }
    if (hasLikelyReads) calls.push(readCall(likelyReads, "inspect the smallest likely source set before editing"));
    else calls.push({ tool: "workspace_search", action: "text", reason: "find one concrete implementation target before editing" });
    calls.push(batchEditCall(hasVerification));
    return result("inspect_first", calls, reasons, telemetry, 2);
  }

  if (hasLikelyReads) {
    calls.push(readCall(likelyReads, "confirm the likely implementation target"));
  }
  calls.push(batchEditCall(hasVerification));
  reasons.push("default:bounded-implementation");
  return result("bounded_path", calls, reasons, telemetry, Math.min(2, calls.length));
}

export function inferAdaptiveIntent(task, explicitIntent) {
  if (explicitIntent) return explicitIntent;
  const value = String(task || "").toLowerCase();
  if (/\b(?:review|audit|inspect diff|code review)\b/.test(value)) return "review";
  if (/\b(?:debug|bug|error|exception|crash|broken|failing|failure)\b/.test(value)) return "debug";
  if (/\b(?:refactor|restructure|cleanup architecture)\b/.test(value)) return "refactor";
  if (/\b(?:understand|explain|trace|architecture|how .* works?)\b/.test(value)) return "understand";
  if (/\b(?:implement|fix|add|create|update|change|patch|migrate|support)\b/.test(value)) return "implement";
  return undefined;
}

export function performanceProfile(snapshot, root, limit = 8, task = "") {
  const all = [
    ...(Array.isArray(snapshot?.recent) ? snapshot.recent : []),
    ...(Array.isArray(snapshot?.active) ? snapshot.active : [])
  ];
  const seen = new Map();
  const selected = [];
  for (let index = all.length - 1; index >= 0 && selected.length < limit; index -= 1) {
    const trace = all[index];
    if (!trace || (root && trace.root !== root)) continue;
    const id = trace.task_id || `${trace.root}:${trace.started_at}`;
    const existing = seen.get(id);
    if (existing) {
      if (!existing.task && trace.task) existing.task = trace.task;
      if ((!existing.tools || Object.keys(existing.tools).length === 0) && trace.tools) existing.tools = trace.tools;
      continue;
    }
    const copy = { ...trace };
    seen.set(id, copy);
    selected.push(copy);
  }
  const taskKey = normalizeTask(task);
  const sameTask = taskKey
    ? selected.filter((trace) => normalizeTask(trace?.task) === taskKey)
    : [];
  const sameTaskSearches = sameTask.reduce((sum, trace) => sum + toolCalls(trace, "workspace_search"), 0);
  if (!selected.length) {
    return {
      samples: 0,
      avg_roundtrips: 0,
      avg_searches: 0,
      avg_reads: 0,
      avg_edits: 0,
      avg_bytes_to_model: 0,
      same_task_contexts: 0,
      same_task_roundtrips: 0,
      same_task_reads: 0,
      same_task_searches: 0,
      same_task_edits: 0
    };
  }
  const average = (key) => round(selected.reduce((sum, trace) => sum + Number(trace?.[key] || 0), 0) / selected.length);
  return {
    samples: selected.length,
    avg_roundtrips: average("tool_roundtrips"),
    avg_searches: average("searches"),
    avg_reads: average("reads"),
    avg_edits: average("edits"),
    avg_bytes_to_model: Math.round(selected.reduce((sum, trace) => sum + Number(trace?.bytes_to_model || 0), 0) / selected.length),
    same_task_contexts: sameTask.length,
    same_task_roundtrips: sameTask.reduce((sum, trace) => sum + Number(trace?.tool_roundtrips || 0), 0),
    same_task_reads: sameTask.reduce((sum, trace) => sum + Number(trace?.reads || 0), 0),
    same_task_searches: sameTaskSearches,
    same_task_edits: sameTask.reduce((sum, trace) => sum + Number(trace?.edits || 0), 0)
  };
}

function toolCalls(trace, prefix) {
  return Object.entries(trace?.tools || {})
    .filter(([name]) => name === prefix || name.startsWith(`${prefix}:`))
    .reduce((sum, [, value]) => sum + Number(value?.calls || 0), 0);
}

function normalizeTask(task) {
  return String(task || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 500);
}

function readCall(likelyReads, reason) {
  return {
    tool: "workspace_read",
    action: "many",
    paths: likelyReads.slice(0, 5).map((entry) => entry.path).filter(Boolean),
    reason
  };
}

function batchEditCall(hasVerification) {
  return {
    tool: "workspace_edit",
    action: "batch",
    ...(hasVerification ? { verify: "changed" } : {}),
    reason: hasVerification
      ? "apply related edits transactionally and verify changed files in the same round-trip"
      : "apply related edits transactionally in one round-trip"
  };
}

function result(mode, calls, reasons, telemetry, roundtripTarget) {
  return {
    mode,
    recommended_calls: calls.slice(0, 2),
    roundtrip_target: Math.max(1, roundtripTarget),
    reasons: [...new Set(reasons)].slice(0, 8),
    telemetry,
    loop_guard: {
      active: telemetry.same_task_contexts > 0 && telemetry.same_task_edits === 0,
      same_task_contexts: telemetry.same_task_contexts || 0,
      prior_reads: telemetry.same_task_reads || 0,
      prior_searches: telemetry.same_task_searches || 0,
      reset_by_edit: (telemetry.same_task_edits || 0) > 0
    }
  };
}

function round(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}
