import { createHash } from "node:crypto";
import path from "node:path";

import type { ContextEvidence, TaskContextRequest } from "../../domain/task-context.js";
import type { MemoryPort } from "../../ports/context-providers.js";

export interface AgentMemoryHttpAdapterOptions {
  baseUrl?: string;
  secret?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  projectId?: (root: string) => string;
  sessionIdForRoot?: (root: string) => string | undefined | Promise<string | undefined>;
  now?: () => number;
  recallCacheTtlMs?: number;
  maxRecallCacheEntries?: number;
}

export interface AgentMemoryHealth {
  status: string;
  service?: string;
}

export interface AgentMemorySessionStartInput {
  sessionId: string;
  project: string;
  cwd: string;
  title?: string;
  agentId?: string;
}

export interface AgentMemoryObservationInput {
  hookType: string;
  sessionId: string;
  project: string;
  cwd: string;
  timestamp: string;
  data: Readonly<Record<string, unknown>>;
}

export interface AgentMemoryRememberInput {
  content: string;
  project: string;
  type?: string;
  concepts?: readonly string[];
  files?: readonly string[];
}

export interface AgentMemorySessionRecord {
  id: string;
  project?: string;
  status?: string;
  agentId?: string;
  cwd?: string;
  startedAt?: string;
  endedAt?: string;
  observationCount?: number;
}

export class AgentMemoryHttpAdapter implements MemoryPort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly projectId: (root: string) => string;
  private readonly recallCacheTtlMs: number;
  private readonly maxRecallCacheEntries: number;
  private readonly recallCache = new Map<string, { expiresAt: number; evidence: readonly ContextEvidence[] }>();
  private readonly recallInFlight = new Map<string, Promise<readonly ContextEvidence[]>>();
  private sessionProjectCache: { expiresAt: number; projects: Map<string, string> } | undefined;

  constructor(private readonly options: AgentMemoryHttpAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:3111").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.projectId = options.projectId ?? defaultProjectId;
    this.recallCacheTtlMs = Math.max(0, options.recallCacheTtlMs ?? 5_000);
    this.maxRecallCacheEntries = Math.max(1, options.maxRecallCacheEntries ?? 64);
  }

  projectForRoot(root: string): string {
    return this.projectId(root);
  }

  async health(): Promise<AgentMemoryHealth> {
    const response = await this.request("/agentmemory/livez", { method: "GET" });
    return asRecord(response) as unknown as AgentMemoryHealth;
  }

  async listSessions(): Promise<readonly AgentMemorySessionRecord[]> {
    const response = asRecord(await this.request("/agentmemory/sessions?limit=500", { method: "GET" }));
    return Array.isArray(response.sessions)
      ? response.sessions.map((value) => asRecord(value) as unknown as AgentMemorySessionRecord)
      : [];
  }

  async startSession(input: AgentMemorySessionStartInput): Promise<void> {
    await this.request("/agentmemory/session/start", {
      method: "POST",
      body: JSON.stringify(input)
    });
    this.invalidateRecallCache(input.project);
  }

  async observe(input: AgentMemoryObservationInput): Promise<void> {
    await this.request("/agentmemory/observe", {
      method: "POST",
      body: JSON.stringify(input)
    });
    this.invalidateRecallCache(input.project);
  }

  async remember(input: AgentMemoryRememberInput): Promise<void> {
    await this.request("/agentmemory/remember", {
      method: "POST",
      body: JSON.stringify(input)
    });
    this.invalidateRecallCache(input.project);
  }

  async endSession(sessionId: string): Promise<void> {
    await this.request("/agentmemory/session/end", {
      method: "POST",
      body: JSON.stringify({ sessionId })
    });
    this.recallCache.clear();
    this.recallInFlight.clear();
    this.sessionProjectCache = undefined;
  }

  async recall(request: TaskContextRequest): Promise<readonly ContextEvidence[]> {
    const project = this.projectId(request.root);
    const sessionId = await this.options.sessionIdForRoot?.(request.root);
    const cacheKey = this.recallCacheKey(request, project, sessionId);
    const now = this.options.now?.() ?? Date.now();
    const cached = this.recallCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      this.touchRecallCache(cacheKey, cached);
      return markMemoryCacheHit(cached.evidence);
    }
    const pending = this.recallInFlight.get(cacheKey);
    if (pending) return markMemoryCacheHit(await pending);

    const operation = this.recallFresh(request, project, sessionId);
    this.recallInFlight.set(cacheKey, operation);
    try {
      const evidence = await operation;
      if (this.recallCacheTtlMs > 0) {
        this.storeRecallCache(cacheKey, { expiresAt: now + this.recallCacheTtlMs, evidence });
      }
      return evidence;
    } finally {
      this.recallInFlight.delete(cacheKey);
    }
  }

  private async recallFresh(
    request: TaskContextRequest,
    project: string,
    sessionId?: string
  ): Promise<readonly ContextEvidence[]> {
    const limit = Math.max(1, Math.min(50, request.budget?.maxItems ?? 12));
    const response = await this.request("/agentmemory/smart-search", {
      method: "POST",
      body: JSON.stringify({
        query: request.task,
        project,
        limit,
        includeLessons: true,
        source: "lca",
        ...(sessionId ? { sessionId } : {})
      })
    });
    const responseRecord = asRecord(response);
    const compactResults = Array.isArray(responseRecord.results)
      ? responseRecord.results as unknown[]
      : [];
    const lessonResults = Array.isArray(responseRecord.lessons)
      ? responseRecord.lessons as unknown[]
      : [];
    const scopedCompactResults = await this.filterCompactResultsByProject(compactResults, project, sessionId);
    const hydratedRaw = await this.hydrateResults(scopedCompactResults, project, limit);
    const hydratedResults = hydratedRaw.filter((item) => matchesExplicitProject(item, project));
    const lessons = lessonResults.filter((item) => matchesExplicitProject(item, project));
    const ranked = rankMemoryResults(
      [...hydratedResults, ...lessons],
      limit,
      this.options.now?.() ?? Date.now()
    );
    const telemetry: MemoryRetrievalTelemetry = {
      fetched: compactResults.length + lessonResults.length,
      hydrated: hydratedRaw.length,
      project_dropped: (compactResults.length - scopedCompactResults.length)
        + (hydratedRaw.length - hydratedResults.length)
        + (lessonResults.length - lessons.length),
      duplicate_dropped: ranked.duplicateDropped,
      selected: ranked.items.length
    };
    const maxCharsPerItem = request.budget?.maxChars
      ? Math.max(500, Math.floor(request.budget.maxChars / Math.max(1, ranked.items.length)))
      : 12_000;

    return ranked.items.map((entry, index) => toEvidence(entry, index, project, maxCharsPerItem, telemetry));
  }

  private recallCacheKey(request: TaskContextRequest, project: string, sessionId?: string): string {
    const changed = [...(request.changedFiles ?? [])].map((file) => path.resolve(request.root, file)).sort();
    return [
      project,
      sessionId ?? "",
      request.intent ?? "",
      request.task.trim(),
      changed.join("\u001f"),
      String(request.budget?.maxItems ?? ""),
      String(request.budget?.maxChars ?? "")
    ].join("\u0000");
  }

  private storeRecallCache(
    key: string,
    value: { expiresAt: number; evidence: readonly ContextEvidence[] }
  ): void {
    this.recallCache.delete(key);
    this.recallCache.set(key, value);
    while (this.recallCache.size > this.maxRecallCacheEntries) {
      const oldest = this.recallCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.recallCache.delete(oldest);
    }
  }

  private touchRecallCache(
    key: string,
    value: { expiresAt: number; evidence: readonly ContextEvidence[] }
  ): void {
    this.recallCache.delete(key);
    this.recallCache.set(key, value);
  }

  private invalidateRecallCache(project?: string): void {
    if (!project) {
      this.recallCache.clear();
      this.recallInFlight.clear();
      return;
    }
    const prefix = `${project}\u0000`;
    for (const key of this.recallCache.keys()) {
      if (key.startsWith(prefix)) this.recallCache.delete(key);
    }
    for (const key of this.recallInFlight.keys()) {
      if (key.startsWith(prefix)) this.recallInFlight.delete(key);
    }
  }

  private async filterCompactResultsByProject(
    compactResults: readonly unknown[],
    project: string,
    activeSessionId?: string
  ): Promise<readonly unknown[]> {
    const observationResults = compactResults.filter((value) => {
      const compact = asRecord(value);
      const obsId = firstString(compact.obsId, compact.id, compact.memoryId, compact.memory_id);
      const resultSessionId = firstString(compact.sessionId, compact.session_id);
      return Boolean(resultSessionId && resultSessionId !== "memory" && !obsId?.startsWith("mem_"));
    });
    if (observationResults.length === 0) return compactResults.filter((item) => matchesExplicitProject(item, project));

    const projects = await this.sessionProjects();
    return compactResults.filter((value) => {
      const compact = asRecord(value);
      if (!matchesExplicitProject(compact, project)) return false;
      const obsId = firstString(compact.obsId, compact.id, compact.memoryId, compact.memory_id);
      const resultSessionId = firstString(compact.sessionId, compact.session_id);
      if (!resultSessionId || resultSessionId === "memory" || obsId?.startsWith("mem_")) return true;
      if (activeSessionId && resultSessionId === activeSessionId) return true;
      return projects.get(resultSessionId) === project;
    });
  }

  private async sessionProjects(): Promise<ReadonlyMap<string, string>> {
    const now = Date.now();
    if (this.sessionProjectCache && this.sessionProjectCache.expiresAt > now) {
      return this.sessionProjectCache.projects;
    }
    const sessions = await this.listSessions();
    const projects = new Map<string, string>();
    for (const session of sessions) {
      if (session.id && session.project) projects.set(session.id, session.project);
    }
    this.sessionProjectCache = { expiresAt: now + 30_000, projects };
    return projects;
  }

  private async hydrateResults(
    compactResults: readonly unknown[],
    project: string,
    limit: number
  ): Promise<readonly unknown[]> {
    const alreadyHydrated: unknown[] = [];
    const directMemories: Array<{ compact: Record<string, unknown>; id: string }> = [];
    const observations: Array<{ compact: Record<string, unknown>; obsId: string; sessionId?: string }> = [];

    for (const value of compactResults) {
      const compact = asRecord(value);
      if (hasContent(compact)) {
        alreadyHydrated.push(compact);
        continue;
      }
      const obsId = firstString(compact.obsId, compact.id, compact.memoryId, compact.memory_id);
      if (!obsId) {
        alreadyHydrated.push(compact);
        continue;
      }
      const sessionId = firstString(compact.sessionId, compact.session_id);
      if (sessionId === "memory" || obsId.startsWith("mem_")) {
        directMemories.push({ compact, id: obsId });
      } else {
        observations.push({ compact, obsId, ...(sessionId ? { sessionId } : {}) });
      }
    }

    const memoryResults = await Promise.all(directMemories.map(async ({ compact, id }) => {
      const response = asRecord(await this.request(`/agentmemory/memories/${encodeURIComponent(id)}`, { method: "GET" }));
      return mergeCompact(asRecord(response.memory), compact);
    }));

    let observationResults: unknown[] = [];
    if (observations.length > 0) {
      const expanded = asRecord(await this.request("/agentmemory/smart-search", {
        method: "POST",
        body: JSON.stringify({
          expandIds: observations.map(({ obsId, sessionId }) => ({
            obsId,
            ...(sessionId ? { sessionId } : {})
          })),
          project,
          limit,
          source: "lca"
        })
      }));
      const expandedItems = Array.isArray(expanded.results) ? expanded.results as unknown[] : [];
      const compactById = new Map(observations.map(({ compact, obsId }) => [obsId, compact]));
      observationResults = expandedItems.map((value) => {
        const item = asRecord(value);
        const observation = asRecord(item.observation);
        const obsId = firstString(item.obsId, observation.id);
        return mergeCompact(observation, obsId ? compactById.get(obsId) : undefined);
      });
    }

    return [...alreadyHydrated, ...memoryResults, ...observationResults];
  }

  private async request(pathname: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("X-AgentMemory-Source", "lca");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (this.options.secret) headers.set("Authorization", `Bearer ${this.options.secret}`);

    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`AgentMemory ${pathname} failed with ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
    }
    return response.json();
  }
}

function markMemoryCacheHit(evidence: readonly ContextEvidence[]): readonly ContextEvidence[] {
  return evidence.map((item) => ({
    ...item,
    metadata: {
      ...(item.metadata ?? {}),
      cache_hit: true,
      cache_layer: "agentmemory-exact-query"
    }
  }));
}

function matchesExplicitProject(value: unknown, project: string): boolean {
  const record = asRecord(value);
  const explicit = firstString(record.project, record.projectId, record.project_id);
  return !explicit || explicit === project;
}

function mergeCompact(
  hydrated: Record<string, unknown>,
  compact: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!compact) return hydrated;
  return {
    ...compact,
    ...hydrated,
    id: hydrated.id ?? compact.obsId ?? compact.id,
    title: hydrated.title ?? compact.title,
    score: compact.score ?? hydrated.score
  };
}

function hasContent(value: Record<string, unknown>): boolean {
  return firstString(value.content, value.summary, value.text, value.lesson, value.narrative) !== undefined;
}

interface RankedMemoryResult {
  item: Record<string, unknown>;
  tier: "durable" | "session_summary" | "task" | "observation";
  rawScore: number | null;
  adjustedScore: number;
  reasons: readonly string[];
}

interface MemoryRetrievalTelemetry {
  fetched: number;
  hydrated: number;
  project_dropped: number;
  duplicate_dropped: number;
  selected: number;
}

function rankMemoryResults(
  values: readonly unknown[],
  limit: number,
  nowMs: number
): { items: readonly RankedMemoryResult[]; duplicateDropped: number } {
  const ranked = values.map((value) => rankMemoryResult(asRecord(value), nowMs));
  ranked.sort((left, right) =>
    right.adjustedScore - left.adjustedScore
    || (right.rawScore ?? 0) - (left.rawScore ?? 0)
    || memoryStableId(left.item).localeCompare(memoryStableId(right.item))
  );

  const selected: RankedMemoryResult[] = [];
  const seen = new Set<string>();
  let duplicateDropped = 0;
  for (const entry of ranked) {
    const signature = memoryDuplicateSignature(entry.item);
    if (seen.has(signature)) {
      duplicateDropped += 1;
      continue;
    }
    seen.add(signature);
    selected.push(entry);
    if (selected.length >= limit) break;
  }
  return { items: selected, duplicateDropped };
}

function rankMemoryResult(item: Record<string, unknown>, nowMs: number): RankedMemoryResult {
  const content = memoryContent(item);
  const title = firstString(item.title, item.type, item.kind) ?? "";
  const type = firstString(item.type, item.kind)?.toLowerCase() ?? "";
  const normalized = `${title}\n${content}`.toLowerCase();
  const files = stringArray(item.files);
  const concepts = stringArray(item.concepts);
  const reasons: string[] = [];
  const rawScoreValue = firstFiniteNumber(item.score, item.relevance, item.similarity, item.strength);
  const rawScore = rawScoreValue ?? null;
  const tier = memoryTier(item, type, normalized);
  const tierBase = tier === "durable" ? 72 : tier === "session_summary" ? 62 : tier === "task" ? 52 : 38;
  let score = tierBase;
  reasons.push(`tier:${tier}`);

  if (rawScoreValue !== undefined) {
    score += normalizeBackendScore(rawScoreValue);
    reasons.push("backend-relevance");
  }

  const recency = recencyAdjustment(item, nowMs);
  if (recency.adjustment !== 0) {
    score += recency.adjustment;
    reasons.push(recency.reason);
  }

  if (files.length > 0) {
    score += 5;
    reasons.push("file-linked");
  }
  if (concepts.length > 0) {
    score += 3;
    reasons.push("concept-linked");
  }
  if (/decision|architect|constraint|lesson/.test(type) || /\bdecision\s*:/i.test(content)) {
    score += 8;
    reasons.push("explicit-decision");
  }

  const confidence = firstFiniteNumber(item.confidence);
  if (confidence !== undefined && confidence < 0.5) {
    score -= 5;
    reasons.push("low-confidence");
  }
  if (/^workspace_context$/i.test(title) || /\bworkspace_context\b/i.test(normalized)) {
    score -= 18;
    reasons.push("raw-context-noise");
  }
  if (item.success === false || item.ok === false || /\b(?:error|failed|failure)\b/i.test(firstString(item.status) ?? "")) {
    score -= 10;
    reasons.push("failure-noise");
  }

  return {
    item,
    tier,
    rawScore,
    adjustedScore: Math.max(1, Math.min(100, Math.round(score * 100) / 100)),
    reasons: [...new Set(reasons)].slice(0, 10)
  };
}

function memoryTier(
  item: Record<string, unknown>,
  type: string,
  normalized: string
): RankedMemoryResult["tier"] {
  if (type.includes("session_summary") || normalized.includes("lca session summary")) return "session_summary";
  if (/decision|architectural|constraint|lesson|durable/.test(type) || /\bdecision\s*:/i.test(normalized)) return "durable";
  if ((type === "fact" || type === "memory") && (stringArray(item.files).length > 0 || stringArray(item.concepts).length > 0)) return "durable";
  if (/checkpoint|task|plan/.test(type) || /\b(?:checkpoint|task plan|next steps)\b/i.test(normalized)) return "task";
  return "observation";
}

function normalizeBackendScore(value: number): number {
  if (value <= 0) return 0;
  if (value <= 1) return Math.min(10, value * 10);
  return Math.min(10, value / 10);
}

function recencyAdjustment(item: Record<string, unknown>, nowMs: number): { adjustment: number; reason: string } {
  const timestamp = firstString(
    item.timestamp, item.createdAt, item.created_at, item.updatedAt, item.updated_at,
    item.endedAt, item.ended_at, item.startedAt, item.started_at
  );
  if (!timestamp) return { adjustment: 0, reason: "" };
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return { adjustment: 0, reason: "" };
  const ageDays = Math.max(0, (nowMs - parsed) / 86_400_000);
  if (ageDays <= 1) return { adjustment: 8, reason: "recent:1d" };
  if (ageDays <= 7) return { adjustment: 6, reason: "recent:7d" };
  if (ageDays <= 30) return { adjustment: 3, reason: "recent:30d" };
  if (ageDays >= 365) return { adjustment: -5, reason: "stale:1y" };
  if (ageDays >= 180) return { adjustment: -2, reason: "stale:180d" };
  return { adjustment: 0, reason: "" };
}

function memoryDuplicateSignature(item: Record<string, unknown>): string {
  const normalizedContent = memoryContent(item)
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:[\d.]+z\b/gi, "<timestamp>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
  if (normalizedContent.length >= 24) return `content:${normalizedContent}`;
  const session = firstString(item.sessionId, item.session_id) ?? "";
  const tool = firstString(item.tool, item.toolName, item.tool_name, asRecord(item.data).tool_name) ?? "";
  const title = firstString(item.title, item.type, item.kind) ?? "";
  return `identity:${session}:${tool}:${title}:${normalizedContent}`.toLowerCase();
}

function memoryStableId(item: Record<string, unknown>): string {
  return firstString(item.id, item.obsId, item.memoryId, item.memory_id)
    ?? createHash("sha256").update(memoryContent(item)).digest("hex").slice(0, 16);
}

function memoryContent(item: Record<string, unknown>): string {
  return firstString(item.content, item.summary, item.text, item.lesson, item.narrative) ?? JSON.stringify(item);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())) : [];
}

function toEvidence(
  ranked: RankedMemoryResult,
  index: number,
  project: string,
  maxChars: number,
  telemetry: MemoryRetrievalTelemetry
): ContextEvidence {
  const item = ranked.item;
  const content = memoryContent(item);
  const title = firstString(item.title, item.type, item.kind) ?? `Memory ${index + 1}`;
  const files = stringArray(item.files);
  const id = firstString(item.id, item.obsId, item.memoryId, item.memory_id)
    ?? `memory-${createHash("sha256").update(`${project}\u0000${index}\u0000${content}`).digest("hex").slice(0, 16)}`;

  return {
    id,
    provider: "agentmemory",
    kind: "memory",
    title,
    content: content.slice(0, maxChars),
    ...(files[0] ? { path: files[0] } : {}),
    score: ranked.adjustedScore,
    metadata: {
      project,
      type: item.type ?? item.kind ?? null,
      files,
      concepts: stringArray(item.concepts),
      memory_tier: ranked.tier,
      raw_score: ranked.rawScore,
      adjusted_score: ranked.adjustedScore,
      selection_reasons: ranked.reasons,
      retrieval: telemetry
    }
  };
}

function defaultProjectId(root: string): string {
  const name = path.basename(path.resolve(root));
  return name || path.resolve(root);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}
