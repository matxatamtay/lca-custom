import type {
  ContextEvidence,
  ContextRanking,
  TaskContextRequest
} from "../../domain/task-context.js";
import type {
  ContextRerankerPort,
  ContextRerankResult
} from "../../ports/context-providers.js";

export const DEFAULT_JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";

const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_CANDIDATES = 24;
const DEFAULT_MAX_STATE_CHARS = 24_000;
const DEFAULT_SCORE_WEIGHT = 30;
const DEFAULT_MIN_CONFIDENCE = 0.35;
const DEFAULT_CIRCUIT_FAILURES = 3;
const DEFAULT_CIRCUIT_OPEN_MS = 30_000;

type FetchLike = typeof globalThis.fetch;

export interface JevContextRerankerOptions {
  apiToken: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  maxCandidates?: number;
  maxStateChars?: number;
  scoreWeight?: number;
  minConfidence?: number;
  circuitFailures?: number;
  circuitOpenMs?: number;
  fetch?: FetchLike;
  now?: () => number;
}

export interface OptionalJevContextRerankerOptions extends Omit<JevContextRerankerOptions, "apiToken"> {
  enabled?: boolean;
  apiToken?: string;
}

interface JevScoreAnswer {
  type?: unknown;
  score?: unknown;
  confidence?: unknown;
}

class JevFallbackError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "JevFallbackError";
  }
}

export function createOptionalJevContextReranker(
  options: OptionalJevContextRerankerOptions = {}
): JevContextReranker | undefined {
  const enabled = options.enabled ?? true;
  const apiToken = String(options.apiToken ?? "").trim();
  if (!enabled || !apiToken) return undefined;

  try {
    return new JevContextReranker({
      apiToken,
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxCandidates !== undefined ? { maxCandidates: options.maxCandidates } : {}),
      ...(options.maxStateChars !== undefined ? { maxStateChars: options.maxStateChars } : {}),
      ...(options.scoreWeight !== undefined ? { scoreWeight: options.scoreWeight } : {}),
      ...(options.minConfidence !== undefined ? { minConfidence: options.minConfidence } : {}),
      ...(options.circuitFailures !== undefined ? { circuitFailures: options.circuitFailures } : {}),
      ...(options.circuitOpenMs !== undefined ? { circuitOpenMs: options.circuitOpenMs } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.now !== undefined ? { now: options.now } : {})
    });
  } catch {
    return undefined;
  }
}

export class JevContextReranker implements ContextRerankerPort {
  private readonly apiToken: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxCandidates: number;
  private readonly maxStateChars: number;
  private readonly scoreWeight: number;
  private readonly minConfidence: number;
  private readonly circuitFailures: number;
  private readonly circuitOpenMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(options: JevContextRerankerOptions) {
    const apiToken = String(options.apiToken ?? "").trim();
    if (!apiToken) throw new Error("JevContextReranker requires a non-empty apiToken.");

    this.apiToken = apiToken;
    this.endpoint = normalizeEndpoint(options.endpoint ?? DEFAULT_JEV_API_URL);
    this.model = String(options.model ?? DEFAULT_JEV_MODEL).trim() || DEFAULT_JEV_MODEL;
    this.timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 10_000);
    this.maxCandidates = boundedInteger(options.maxCandidates, DEFAULT_MAX_CANDIDATES, 2, 64);
    this.maxStateChars = boundedInteger(options.maxStateChars, DEFAULT_MAX_STATE_CHARS, 2_000, 100_000);
    this.scoreWeight = boundedNumber(options.scoreWeight, DEFAULT_SCORE_WEIGHT, 0, 100);
    this.minConfidence = boundedNumber(options.minConfidence, DEFAULT_MIN_CONFIDENCE, 0, 1);
    this.circuitFailures = boundedInteger(options.circuitFailures, DEFAULT_CIRCUIT_FAILURES, 1, 20);
    this.circuitOpenMs = boundedInteger(options.circuitOpenMs, DEFAULT_CIRCUIT_OPEN_MS, 1_000, 300_000);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async rerank(
    request: TaskContextRequest,
    evidence: readonly ContextEvidence[]
  ): Promise<ContextRerankResult> {
    const candidates = evidence
      .filter((item) => !isSensitiveEvidence(item))
      .slice()
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, this.maxCandidates);

    if (candidates.length < 2) {
      return {
        evidence,
        ranking: {
          provider: "rule",
          status: "skipped",
          latencyMs: 0,
          candidates: candidates.length,
          fallbackReason: candidates.length === 0 ? "no-remote-safe-candidates" : "single-candidate"
        }
      };
    }

    if (this.now() < this.circuitOpenUntil) {
      return {
        evidence,
        ranking: {
          provider: "rule",
          status: "fallback",
          latencyMs: 0,
          candidates: candidates.length,
          fallbackReason: "circuit-open"
        }
      };
    }

    const startedAt = performance.now();
    let attemptedCandidates = candidates.length;
    try {
      const prepared = buildRequestPayload(request, candidates, this.model, this.maxStateChars);
      const activeCandidates = prepared.candidates;
      attemptedCandidates = activeCandidates.length;
      const stateChars = prepared.stateChars;
      if (activeCandidates.length < 2) {
        return {
          evidence,
          ranking: {
            provider: "rule",
            status: "skipped",
            latencyMs: elapsedMs(startedAt),
            candidates: activeCandidates.length,
            candidateCap: this.maxCandidates,
            stateChars,
            fallbackReason: "state-budget"
          }
        };
      }

      const response = await fetchWithTimeout(
        this.fetchImpl,
        this.endpoint,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(prepared.payload)
        },
        this.timeoutMs
      );

      if (!response.ok) throw new JevFallbackError(`http-${response.status}`);

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new JevFallbackError("malformed-json");
      }

      const answers = asRecord(asRecord(parsed).answers);
      const replacements = new Map<string, ContextEvidence>();
      let accepted = 0;
      const sufficiencyAnswer = answers.context_sufficiency as JevScoreAnswer | undefined;
      const sufficiencyScore = finiteNumber(sufficiencyAnswer?.score);
      const sufficiencyConfidence = finiteNumber(sufficiencyAnswer?.confidence);
      const sufficiency =
        sufficiencyScore !== undefined &&
        sufficiencyConfidence !== undefined &&
        sufficiencyScore >= 0 &&
        sufficiencyScore <= 2 &&
        sufficiencyConfidence >= this.minConfidence &&
        sufficiencyConfidence <= 1
          ? (["insufficient", "partial", "sufficient"] as const)[Math.round(sufficiencyScore)]
          : undefined;

      for (let index = 0; index < activeCandidates.length; index += 1) {
        const candidate = activeCandidates[index];
        if (!candidate) continue;
        const answer = answers[`candidate_${index}`] as JevScoreAnswer | undefined;
        const score = finiteNumber(answer?.score);
        const confidence = finiteNumber(answer?.confidence);

        if (score === undefined || confidence === undefined || score < 0 || score > 2 || confidence < 0 || confidence > 1) {
          throw new JevFallbackError("malformed-answer");
        }

        if (confidence < this.minConfidence) continue;

        const relevance = score / 2;
        const boost = relevance * confidence * this.scoreWeight;
        const key = selectionKey(candidate);
        replacements.set(key, {
          ...candidate,
          score: (candidate.score ?? 0) + boost,
          metadata: {
            ...(candidate.metadata ?? {}),
            jevRerank: {
              model: this.model,
              relevance,
              score,
              confidence,
              boost: round(boost)
            }
          }
        });
        accepted += 1;
      }

      if (accepted === 0) throw new JevFallbackError("low-confidence");

      this.consecutiveFailures = 0;
      this.circuitOpenUntil = 0;
      return {
        evidence: evidence.map((item) => replacements.get(selectionKey(item)) ?? item),
        ranking: {
          provider: "jev",
          status: "applied",
          latencyMs: elapsedMs(startedAt),
          model: this.model,
          candidates: activeCandidates.length,
          accepted,
          candidateCap: this.maxCandidates,
          stateChars,
          ...(sufficiency ? { sufficiency } : {}),
          ...(sufficiency ? { sufficiencyConfidence: round(sufficiencyConfidence!) } : {})
        }
      };
    } catch (error) {
      const reason = fallbackReason(error);
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.circuitFailures) {
        this.circuitOpenUntil = this.now() + this.circuitOpenMs;
      }

      return {
        evidence,
        ranking: {
          provider: "rule",
          status: "fallback",
          latencyMs: elapsedMs(startedAt),
          model: this.model,
          candidates: attemptedCandidates,
          candidateCap: this.maxCandidates,
          fallbackReason: reason
        }
      };
    }
  }
}

function buildRequestPayload(
  request: TaskContextRequest,
  candidates: readonly ContextEvidence[],
  model: string,
  maxStateChars: number
): {
  payload: Readonly<Record<string, unknown>>;
  candidates: readonly ContextEvidence[];
  stateChars: number;
} {
  const header = [
    "You are ranking retrieved coding evidence for a local coding agent.",
    `Task: ${sanitizeRemoteText(request.task, 1_000)}`,
    `Intent: ${request.intent ?? "understand"}`,
    request.changedFiles?.length
      ? `Changed files: ${sanitizeRemoteText(request.changedFiles.slice(0, 20).join(", "), 1_000)}`
      : "",
    "",
    "Candidates:"
  ].filter(Boolean).join("\n");

  const blocks: string[] = [];
  const selected: ContextEvidence[] = [];
  let usedChars = header.length;

  for (const candidate of candidates) {
    const index = selected.length;
    const block = [
      `[candidate_${index}]`,
      `provider=${candidate.provider}`,
      `kind=${candidate.kind}`,
      `path=${sanitizeRemoteText(candidate.path ?? "", 240)}`,
      `symbol=${sanitizeRemoteText(candidate.symbol ?? "", 160)}`,
      `title=${sanitizeRemoteText(candidate.title, 240)}`,
      `content=${sanitizeRemoteText(candidate.content, 500)}`
    ].join("\n");

    const remaining = maxStateChars - usedChars - 2;
    if (remaining < 160) break;
    const boundedBlock = block.slice(0, remaining);
    blocks.push(boundedBlock);
    selected.push(candidate);
    usedChars += boundedBlock.length + 2;
    if (boundedBlock.length < block.length) break;
  }

  const questions: Record<string, unknown> = {};
  for (let index = 0; index < selected.length; index += 1) {
    questions[`candidate_${index}`] = {
      type: "score",
      instructions: `How useful is candidate_${index} as evidence for solving the coding task? Judge direct task relevance and actionability, not writing quality.`,
      criteria: [
        "Unrelated or not useful for solving the task",
        "Useful supporting context",
        "Directly useful evidence needed to solve the task"
      ]
    };
  }
  questions.context_sufficiency = {
    type: "score",
    instructions: "Considering the coding task and the candidate evidence collectively, is there enough relevant evidence to begin solving the task without another broad retrieval pass?",
    criteria: [
      "Insufficient: evidence is mostly irrelevant or misses the core implementation area",
      "Partial: useful evidence exists, but another targeted lookup is likely needed",
      "Sufficient: evidence covers the core implementation area well enough to begin solving the task"
    ]
  };

  const state = [header, ...blocks].join("\n\n");
  return {
    payload: {
      state,
      model,
      questions
    },
    candidates: selected,
    stateChars: state.length
  };
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new JevFallbackError("timeout");
    throw new JevFallbackError(error instanceof Error && error.name === "AbortError" ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
}

function isSensitiveEvidence(evidence: ContextEvidence): boolean {
  const value = String(evidence.path ?? "").replace(/\\/g, "/");
  if (!value) return false;
  return /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.pypirc|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_(?:rsa|ed25519)(?:\.[^/]*)?|[^/]+\.(?:pem|key|p12|pfx))$/i.test(value);
}

function sanitizeRemoteText(value: string, maxChars: number): string {
  return String(value ?? "")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted private material]")
    .replace(/\b(authorization\s*:\s*bearer)\s+[^\s]+/gi, "$1 [redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\b\s*[:=]\s*([^\s,;]+)/gi, "$1=[redacted]")
    .replace(/\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, "[redacted jwt]")
    .slice(0, maxChars);
}

function selectionKey(evidence: ContextEvidence): string {
  return `${evidence.provider}\u0000${evidence.id}`;
}

function normalizeEndpoint(value: string): string {
  const url = new URL(String(value).trim());
  if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
    throw new Error("Jev API endpoint must use HTTPS unless it is loopback.");
  }
  return url.toString();
}

function isLoopback(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = finiteNumber(value);
  if (parsed === undefined) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = finiteNumber(value);
  if (parsed === undefined) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function fallbackReason(error: unknown): string {
  if (error instanceof JevFallbackError) return error.reason;
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  return "jev-error";
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
