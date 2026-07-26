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

  constructor(private readonly options: AgentMemoryHttpAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:3111").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.projectId = options.projectId ?? defaultProjectId;
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
  }

  async observe(input: AgentMemoryObservationInput): Promise<void> {
    await this.request("/agentmemory/observe", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async remember(input: AgentMemoryRememberInput): Promise<void> {
    await this.request("/agentmemory/remember", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async endSession(sessionId: string): Promise<void> {
    await this.request("/agentmemory/session/end", {
      method: "POST",
      body: JSON.stringify({ sessionId })
    });
  }

  async recall(request: TaskContextRequest): Promise<readonly ContextEvidence[]> {
    const limit = Math.max(1, Math.min(50, request.budget?.maxItems ?? 12));
    const project = this.projectId(request.root);
    const sessionId = await this.options.sessionIdForRoot?.(request.root);
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
    const hydratedResults = await this.hydrateResults(compactResults, project, limit);
    const lessons = Array.isArray(responseRecord.lessons)
      ? responseRecord.lessons as unknown[]
      : [];
    const results = [...hydratedResults, ...lessons];
    const maxCharsPerItem = request.budget?.maxChars
      ? Math.max(500, Math.floor(request.budget.maxChars / Math.max(1, results.length)))
      : 12_000;

    return results.map((item, index) => toEvidence(item, index, project, maxCharsPerItem));
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
  return firstString(value.content, value.summary, value.text, value.lesson) !== undefined;
}

function toEvidence(
  value: unknown,
  index: number,
  project: string,
  maxChars: number
): ContextEvidence {
  const item = asRecord(value);
  const content = firstString(item.content, item.summary, item.text, item.lesson) ?? JSON.stringify(item);
  const title = firstString(item.title, item.type, item.kind) ?? `Memory ${index + 1}`;
  const files = Array.isArray(item.files) ? item.files.filter((entry): entry is string => typeof entry === "string") : [];
  const id = firstString(item.id, item.memoryId, item.memory_id)
    ?? `memory-${createHash("sha256").update(`${project}\u0000${index}\u0000${content}`).digest("hex").slice(0, 16)}`;
  const score = firstFiniteNumber(item.score, item.relevance, item.similarity, item.strength);

  return {
    id,
    provider: "agentmemory",
    kind: "memory",
    title,
    content: content.slice(0, maxChars),
    ...(files[0] ? { path: files[0] } : {}),
    ...(score !== undefined ? { score } : {}),
    metadata: {
      project,
      type: item.type ?? item.kind ?? null,
      files,
      concepts: Array.isArray(item.concepts) ? item.concepts : []
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
