import { normalizeCandidate } from "./candidate-schema.mjs";

export function scoreCandidate(input) {
  const candidate = normalizeCandidate(input);
  const implementationCost = Math.max(0.05, candidate.estimated_cost);
  const raw = (
    candidate.impact
    * candidate.frequency
    * candidate.confidence
    * candidate.regression_probability
  ) / implementationCost;
  return {
    ...input,
    ...candidate,
    score: roundRatio(Math.min(1, Math.max(0, raw)))
  };
}

export function rankCandidates(candidates = []) {
  return candidates
    .map(scoreCandidate)
    .sort((left, right) => (
      right.score - left.score
      || right.impact - left.impact
      || right.confidence - left.confidence
      || left.id.localeCompare(right.id)
    ));
}

function roundRatio(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}
