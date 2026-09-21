const DEFAULT_MAX_ITEMS = 18;
const DEFAULT_MAX_CHARS = 60_000;

export function createContextBudget({ maxItems, maxChars, providerCount = 0, hasLocalState = false } = {}) {
  const requestedItems = clampInt(maxItems, 3, 100, DEFAULT_MAX_ITEMS);
  const totalChars = clampInt(maxChars, 1_000, 200_000, DEFAULT_MAX_CHARS);
  const effectiveItems = Math.max(requestedItems, providerCount);
  const minimumProviderChars = providerCount > 0 ? Math.min(totalChars, providerCount * 160) : 0;
  const desiredStateChars = hasLocalState ? Math.min(12_000, Math.max(320, Math.floor(totalChars * 0.25))) : 0;
  const stateSoftCap = Math.max(0, Math.min(desiredStateChars, totalChars - minimumProviderChars));
  return {
    requestedItems,
    effectiveItems,
    totalChars,
    providerCount,
    minimumProviderChars,
    stateSoftCap
  };
}

export function approximateEvidenceChars(evidence) {
  if (!evidence) return 0;
  return String(evidence.title || "").length
    + String(evidence.content || "").length
    + String(evidence.path || "").length
    + String(evidence.symbol || "").length
    + 48;
}

export function truncateEvidenceToBudget(evidence, budgetChars) {
  const budget = Math.max(0, Math.floor(Number(budgetChars) || 0));
  if (!evidence || budget <= 0) return null;
  const baseCost = approximateEvidenceChars({ ...evidence, content: "" });
  if (baseCost > budget) {
    const titleBudget = Math.max(0, budget - 32);
    return {
      ...evidence,
      title: String(evidence.title || "").slice(0, titleBudget),
      content: "",
      metadata: { ...(evidence.metadata || {}), context_budget_truncated: true }
    };
  }
  const contentBudget = Math.max(0, budget - baseCost);
  const content = String(evidence.content || "");
  if (content.length <= contentBudget) return evidence;
  return {
    ...evidence,
    content: content.slice(0, contentBudget),
    metadata: { ...(evidence.metadata || {}), context_budget_truncated: true }
  };
}

export function jsonChars(value) {
  try { return JSON.stringify(value).length; } catch { return 0; }
}

function clampInt(value, min, max, fallback) {
  const number = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback;
  return Math.max(min, Math.min(max, number));
}
