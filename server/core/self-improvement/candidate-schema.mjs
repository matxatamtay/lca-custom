import { createHash } from "node:crypto";

export const IMPROVEMENT_CATEGORIES = Object.freeze([
  "PERFORMANCE",
  "RELIABILITY",
  "CORRECTNESS",
  "SECURITY",
  "TEST_QUALITY",
  "CODE_HEALTH",
  "DEPENDENCY",
  "AGENT_STRATEGY"
]);

const CATEGORY_SET = new Set(IMPROVEMENT_CATEGORIES);

export function normalizeCandidate(input = {}) {
  const category = normalizeCategory(input.category);
  const component = safeText(input.component || input.affected_component || "unknown", 160);
  const affectedPaths = uniqueStrings(input.affected_paths, 200, 500).sort();
  const evidence = sanitizeValue(input.evidence);
  const baseline = sanitizeValue(input.baseline);
  const source = uniqueStrings(Array.isArray(input.source) ? input.source : [input.source], 20, 120).sort();
  const fingerprint = safeText(input.fingerprint, 128) || candidateFingerprint({
    category,
    component,
    affected_paths: affectedPaths,
    evidence
  });
  const id = safeText(input.id, 160) || `si-${category.toLowerCase()}-${fingerprint.slice(0, 12)}`;

  return {
    id,
    source,
    fingerprint,
    category,
    component,
    affected_paths: affectedPaths,
    evidence,
    baseline,
    confidence: clamp01(input.confidence),
    impact: clamp01(input.impact),
    frequency: clamp01(input.frequency),
    estimated_cost: clampCost(input.estimated_cost),
    regression_probability: clamp01(input.regression_probability ?? 1),
    estimated_benefit: safeText(input.estimated_benefit, 240) || null
  };
}

export function candidateFingerprint(input = {}) {
  const evidenceFingerprint = safeText(input?.evidence?.fingerprint, 240)
    || stableFingerprint(sanitizeValue(input?.evidence));
  return stableFingerprint({
    category: normalizeCategory(input.category),
    component: safeText(input.component || input.affected_component || "unknown", 160),
    evidence_fingerprint: evidenceFingerprint,
    affected_paths: uniqueStrings(input.affected_paths, 200, 500).sort()
  });
}

export function stableFingerprint(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(sanitizeValue(value)));
}

function normalizeCategory(value) {
  const normalized = String(value || "CODE_HEALTH").trim().toUpperCase();
  return CATEGORY_SET.has(normalized) ? normalized : "CODE_HEALTH";
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function clampCost(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.max(0.01, Math.min(1, number));
}

function safeText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function uniqueStrings(values, maxItems, maxChars) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().slice(0, maxChars)))]
    .slice(0, maxItems);
}

function sanitizeValue(value, depth = 0) {
  if (depth > 8) return null;
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return value.slice(0, 2_000);
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
      String(key).slice(0, 160),
      sanitizeValue(item, depth + 1)
    ]));
  }
  return String(value).slice(0, 2_000);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}
