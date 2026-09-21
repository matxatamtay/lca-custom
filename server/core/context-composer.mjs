import {
  approximateEvidenceChars,
  createContextBudget,
  jsonChars,
  truncateEvidenceToBudget
} from "./context-budget.mjs";

const PROVIDERS = ["filesystem", "semantic", "codegraph", "agentmemory"];

export function composeTaskContext(options) {
  const {
    context,
    taskState = null,
    checkpoint = null,
    requestChangedFiles = [],
    maxItems,
    maxChars
  } = options;

  const rawEvidence = dedupeEvidence(Array.isArray(context?.evidence) ? context.evidence : []);
  const sourceEvidence = compactProviderEvidence(rawEvidence);
  const providersWithEvidence = PROVIDERS.filter((provider) => sourceEvidence.some((item) => item.provider === provider));
  const hasLocalState = Boolean(taskState || checkpoint);
  const budget = createContextBudget({
    maxItems,
    maxChars,
    providerCount: providersWithEvidence.length,
    hasLocalState
  });

  const stateContext = buildStateContext({
    taskState,
    checkpoint,
    requestChangedFiles,
    maxChars: budget.stateSoftCap
  });
  const stateChars = stateContext ? jsonChars(stateContext) : 0;
  const evidenceBudget = Math.max(0, budget.totalChars - stateChars);
  const evidence = selectEvidence(sourceEvidence, {
    maxItems: budget.effectiveItems,
    maxChars: evidenceBudget,
    providers: providersWithEvidence
  });
  const evidenceChars = evidence.reduce((sum, item) => sum + approximateEvidenceChars(item), 0);
  const providerItems = Object.fromEntries(PROVIDERS.map((provider) => [
    provider,
    {
      available: sourceEvidence.filter((item) => item.provider === provider).length,
      selected: evidence.filter((item) => item.provider === provider).length
    }
  ]));
  const usedChars = stateChars + evidenceChars;

  return {
    ...context,
    evidence,
    state_context: stateContext,
    composition: {
      version: 1,
      budget: {
        requested_items: budget.requestedItems,
        effective_items: budget.effectiveItems,
        max_chars: budget.totalChars,
        state_soft_cap_chars: budget.stateSoftCap,
        state_used_chars: stateChars,
        evidence_budget_chars: evidenceBudget,
        evidence_used_chars: evidenceChars,
        used_chars: usedChars,
        reclaimed_state_chars: Math.max(0, budget.stateSoftCap - stateChars)
      },
      local_state: {
        available: hasLocalState,
        included: Boolean(stateContext),
        task: Boolean(taskState),
        checkpoint: Boolean(checkpoint)
      },
      compaction: {
        input_items: rawEvidence.length,
        candidate_items: sourceEvidence.length,
        dropped_items: Math.max(0, rawEvidence.length - sourceEvidence.length)
      },
      providers: providerItems,
      truncated: evidence.length < sourceEvidence.length
        || evidence.some((item) => item.metadata?.context_budget_truncated === true)
        || (stateContext?.truncated === true)
    }
  };
}

export function buildStateContext({ taskState, checkpoint, requestChangedFiles = [], maxChars = 0 }) {
  const cap = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (cap <= 0 || (!taskState && !checkpoint)) return null;

  const steps = Array.isArray(taskState?.steps) ? taskState.steps : [];
  const pending = steps.filter((step) => !step?.done).map((step) => compactText(step?.text)).filter(Boolean);
  const done = steps.filter((step) => step?.done).length;
  const changedFiles = dedupeStrings([
    ...(requestChangedFiles || []),
    ...(taskState?.changed_files || []),
    ...(checkpoint?.task?.changed_files || []),
    ...(checkpoint?.files_touched || [])
  ]);
  const blockers = normalizeFacts(taskState?.blockers || checkpoint?.task?.blockers, "blocker");
  const decisions = normalizeFacts(taskState?.decisions || checkpoint?.task?.decisions, "decision");
  const discoveries = normalizeFacts(taskState?.discoveries || checkpoint?.task?.discoveries, "discovery");
  const verification = taskState?.last_verification || checkpoint?.task?.last_verification || null;

  const state = { version: 1 };
  let truncated = false;
  const taskHeader = cleanObject({
    goal: compactText(taskState?.goal || checkpoint?.task?.goal || checkpoint?.summary),
    status: compactText(taskState?.status || checkpoint?.task?.status),
    progress: steps.length ? `${done}/${steps.length}` : compactText(checkpoint?.task?.progress),
    updated: taskState?.updated || checkpoint?.task?.updated || null
  });
  if (Object.keys(taskHeader).length) {
    if (!tryAssign(state, "task", taskHeader, cap)) {
      const tiny = cleanObject({ goal: taskHeader.goal?.slice(0, Math.max(40, cap - 100)), status: taskHeader.status });
      if (!tryAssign(state, "task", tiny, cap)) return null;
      truncated = true;
    }
  }

  truncated = addArraySection(state, "pending_steps", pending, cap, 20) || truncated;
  truncated = addArraySection(state, "changed_files", changedFiles, cap, 60) || truncated;
  truncated = addArraySection(state, "blockers", blockers, cap, 12) || truncated;
  truncated = addArraySection(state, "decisions", decisions, cap, 12) || truncated;
  if (verification) {
    const compactVerification = cleanObject({
      at: verification.at,
      tool: verification.tool,
      ok: verification.ok,
      failed: verification.failed,
      ran: verification.ran,
      gates: Array.isArray(verification.gates) ? verification.gates.slice(-8) : undefined
    });
    if (!tryAssign(state, "last_verification", compactVerification, cap)) truncated = true;
  }
  truncated = addArraySection(state, "discoveries", discoveries, cap, 10) || truncated;

  const checkpointMeta = cleanObject({
    saved_at: checkpoint?.saved_at,
    reason: checkpoint?.reason,
    summary: checkpoint?.summary && checkpoint?.summary !== taskHeader.goal ? compactText(checkpoint.summary) : undefined
  });
  if (Object.keys(checkpointMeta).length && !tryAssign(state, "checkpoint", checkpointMeta, cap)) truncated = true;

  if (truncated) state.truncated = true;
  return state;
}

function selectEvidence(source, { maxItems, maxChars, providers }) {
  if (!source.length || maxItems <= 0 || maxChars <= 0) return [];
  const representatives = [];
  const selectedKeys = new Set();
  for (const provider of providers) {
    const item = source.find((candidate) => candidate.provider === provider);
    if (!item) continue;
    representatives.push(item);
    selectedKeys.add(evidenceKey(item));
  }
  const rest = source.filter((item) => !selectedKeys.has(evidenceKey(item)));
  const ordered = [...representatives, ...rest].slice(0, Math.max(maxItems, representatives.length));
  const result = [];
  let remaining = maxChars;

  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index];
    const representativesRemaining = Math.max(0, representatives.length - result.length - 1);
    const minReserve = representativesRemaining * 120;
    const itemBudget = Math.max(0, remaining - minReserve);
    if (itemBudget <= 0) break;
    const fitted = truncateEvidenceToBudget(item, itemBudget);
    if (!fitted) continue;
    result.push(fitted);
    remaining = Math.max(0, remaining - approximateEvidenceChars(fitted));
  }

  return result;
}

function compactProviderEvidence(evidence) {
  const semantic = new Map();
  const filesystem = [];
  const agentmemory = [];
  const codegraph = [];
  const other = [];
  const filesystemPaths = new Set();

  for (const item of evidence) {
    if (item?.provider === "semantic") {
      const key = String(item.symbol || item.title || item.id || "").toLowerCase();
      const existing = semantic.get(key);
      if (!existing || semanticQuality(item) > semanticQuality(existing)) semantic.set(key, item);
      continue;
    }
    if (item?.provider === "filesystem") {
      const key = item.path || item.id;
      if (filesystemPaths.has(key)) continue;
      filesystemPaths.add(key);
      if (filesystem.length < 8) filesystem.push(item);
      continue;
    }
    if (item?.provider === "agentmemory") {
      if (agentmemory.length < 4) agentmemory.push(item);
      continue;
    }
    if (item?.provider === "codegraph") {
      if (codegraph.length < 1) codegraph.push(item);
      continue;
    }
    other.push(item);
  }

  return [...filesystem, ...[...semantic.values()].slice(0, 4), ...codegraph, ...agentmemory, ...other];
}

function semanticQuality(item) {
  const metadata = item?.metadata || {};
  const definitions = Number(metadata.definition_count || 0);
  const references = Number(metadata.reference_count || 0);
  const path = String(item?.path || "").toLowerCase();
  const testPenalty = /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|$)|\.(?:test|spec)\./.test(path) ? 20 : 0;
  const resolvedBonus = definitions > 0 ? 25 : 0;
  return resolvedBonus + Math.min(15, references) + Number(item?.score || 0) - testPenalty;
}

function dedupeEvidence(evidence) {
  const seen = new Set();
  const result = [];
  for (const item of evidence) {
    const key = evidenceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function evidenceKey(item) {
  return [item?.provider, item?.path || "", item?.symbol || "", item?.content || ""].join("\u0000");
}

function addArraySection(state, key, values, cap, limit) {
  if (!Array.isArray(values) || values.length === 0) return false;
  const bounded = values.slice(-limit);
  if (tryAssign(state, key, bounded, cap)) return values.length > bounded.length;
  for (let count = bounded.length - 1; count >= 1; count -= 1) {
    if (tryAssign(state, key, bounded.slice(-count), cap)) return true;
  }
  return true;
}

function tryAssign(state, key, value, cap) {
  const candidate = { ...state, [key]: value };
  if (jsonChars(candidate) > cap) return false;
  state[key] = value;
  return true;
}

function normalizeFacts(items, kind) {
  if (!Array.isArray(items)) return [];
  const result = [];
  const seen = new Set();
  for (const item of items) {
    let value;
    if (typeof item === "string") value = { text: compactText(item) };
    else if (kind === "decision") value = cleanObject({ decision: compactText(item?.decision), why: compactText(item?.why), at: item?.at });
    else value = cleanObject({ text: compactText(item?.text), refs: dedupeStrings(item?.refs || []).slice(-8), at: item?.at });
    const signature = JSON.stringify(value);
    if (!signature || signature === "{}" || seen.has(signature)) continue;
    seen.add(signature);
    result.push(value);
  }
  return result;
}

function dedupeStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const text = compactText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function compactText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 1200);
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}
