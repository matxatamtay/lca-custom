import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  AgentMemoryObservationInput,
  AgentMemoryRememberInput,
  AgentMemorySessionRecord,
  AgentMemorySessionStartInput
} from "../adapters/agentmemory/agentmemory-http-adapter.js";
import type { ContextEvidence, ContextCoverage, TaskContextRequest } from "../domain/task-context.js";
import type { MemoryPort } from "../ports/context-providers.js";
import type { AgentMemorySupervisor } from "./agentmemory-supervisor.js";

export interface AgentMemorySessionClient {
  projectForRoot(root: string): string;
  listSessions(): Promise<readonly AgentMemorySessionRecord[]>;
  startSession(input: AgentMemorySessionStartInput): Promise<void>;
  observe(input: AgentMemoryObservationInput): Promise<void>;
  remember(input: AgentMemoryRememberInput): Promise<void>;
  endSession(sessionId: string): Promise<void>;
}

export interface AgentMemoryToolCallObservation {
  tool: string;
  root: string;
  argsSummary: string;
  outputSummary: string;
  success: boolean;
  durationMs: number;
  task?: string;
  files?: readonly string[];
  coverage?: ContextCoverage;
  evidenceCount?: number;
}

export interface AgentMemoryDecisionInput {
  root: string;
  decision: string;
  why: string;
  files?: readonly string[];
}

export interface AgentMemorySessionManagerOptions {
  supervisor: AgentMemorySupervisor;
  client: AgentMemorySessionClient;
  now?: () => Date;
  createId?: () => string;
  maxTasks?: number;
  maxFiles?: number;
  maxSummaryChars?: number;
  isProcessAlive?: (pid: number) => boolean;
}

interface SessionState {
  root: string;
  project: string;
  sessionId: string;
  startedAt: string;
  tasks: string[];
  toolCounts: Map<string, number>;
  files: Set<string>;
  observations: number;
  decisions: number;
  failures: number;
}

export class AgentMemorySessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly pendingSessions = new Map<string, Promise<SessionState>>();
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly maxTasks: number;
  private readonly maxFiles: number;
  private readonly maxSummaryChars: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly reconciliationPromises = new Map<string, Promise<void>>();
  private readonly reconciledProjects = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private closing = false;
  private closed = false;

  constructor(private readonly options: AgentMemorySessionManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.maxTasks = options.maxTasks ?? 20;
    this.maxFiles = options.maxFiles ?? 50;
    this.maxSummaryChars = options.maxSummaryChars ?? 4_000;
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  }

  currentSessionId(root: string): string | undefined {
    return this.sessions.get(normalizeRoot(root))?.sessionId;
  }

  async ensureSession(root: string, title?: string): Promise<SessionState> {
    if (this.closed) throw new Error("AgentMemory session manager is closed.");
    const normalizedRoot = normalizeRoot(root);
    const existing = this.sessions.get(normalizedRoot);
    if (existing) {
      this.addTask(existing, title);
      return existing;
    }
    const pending = this.pendingSessions.get(normalizedRoot);
    if (pending) {
      const state = await pending;
      this.addTask(state, title);
      return state;
    }

    const creation = this.createSession(normalizedRoot, title).finally(() => {
      this.pendingSessions.delete(normalizedRoot);
    });
    this.pendingSessions.set(normalizedRoot, creation);
    return creation;
  }

  recordToolCall(observation: AgentMemoryToolCallObservation): Promise<void> {
    if (this.closing || this.closed) return Promise.resolve();
    const operation = this.queue.then(() => this.persistToolCall(observation));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  recordDecision(input: AgentMemoryDecisionInput): Promise<void> {
    if (this.closing || this.closed) return Promise.resolve();
    const operation = this.queue.then(() => this.persistDecision(input));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  flush(): Promise<void> {
    return this.queue;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.closeAll().finally(() => {
      this.closed = true;
    });
    return this.closePromise;
  }

  private async createSession(root: string, title?: string): Promise<SessionState> {
    await this.options.supervisor.ensureReady();
    const project = this.options.client.projectForRoot(root);
    await this.reconcileStaleSessions(project);
    const sessionId = `lca-${process.pid}-${this.createId()}`;
    const startedAt = this.now().toISOString();
    await this.options.client.startSession({
      sessionId,
      project,
      cwd: root,
      ...(title ? { title: truncate(title, 200) } : {}),
      agentId: "lca"
    });
    const state: SessionState = {
      root,
      project,
      sessionId,
      startedAt,
      tasks: [],
      toolCounts: new Map(),
      files: new Set(),
      observations: 0,
      decisions: 0,
      failures: 0
    };
    this.addTask(state, title);
    this.sessions.set(root, state);
    return state;
  }

  private async reconcileStaleSessions(project: string): Promise<void> {
    if (this.reconciledProjects.has(project)) return;
    const pending = this.reconciliationPromises.get(project);
    if (pending) return pending;
    const reconciliation = (async () => {
      const sessions = await this.options.client.listSessions();
      for (const session of sessions) {
        if (session.project !== project || session.status !== "active" || session.agentId !== "lca") continue;
        const pid = parseLcaSessionPid(session.id);
        if (pid === undefined || pid === process.pid || this.isProcessAlive(pid)) continue;
        await this.options.client.endSession(session.id).catch(() => undefined);
      }
      this.reconciledProjects.add(project);
    })().finally(() => {
      this.reconciliationPromises.delete(project);
    });
    this.reconciliationPromises.set(project, reconciliation);
    return reconciliation;
  }

  private async persistToolCall(observation: AgentMemoryToolCallObservation): Promise<void> {
    const state = await this.ensureSession(observation.root, observation.task);
    state.observations += 1;
    state.toolCounts.set(observation.tool, (state.toolCounts.get(observation.tool) ?? 0) + 1);
    if (!observation.success) state.failures += 1;
    this.addTask(state, observation.task);
    for (const file of observation.files ?? []) {
      if (state.files.size >= this.maxFiles) break;
      if (file.trim()) state.files.add(file.trim());
    }

    await this.options.client.observe({
      hookType: "post_tool_use",
      sessionId: state.sessionId,
      project: state.project,
      cwd: state.root,
      timestamp: this.now().toISOString(),
      data: {
        tool_name: observation.tool,
        tool_input: truncate(observation.argsSummary, 2_000),
        tool_output: truncate(observation.outputSummary, 3_000),
        success: observation.success,
        duration_ms: observation.durationMs,
        ...(observation.task ? { task: truncate(observation.task, 500) } : {}),
        ...(observation.coverage ? { context_coverage: observation.coverage } : {}),
        ...(observation.evidenceCount !== undefined ? { evidence_count: observation.evidenceCount } : {})
      }
    });
  }

  private async persistDecision(input: AgentMemoryDecisionInput): Promise<void> {
    const decision = input.decision.trim();
    const why = input.why.trim();
    if (!decision || !why) throw new Error("AgentMemory decision requires non-empty decision and why fields.");
    const state = await this.ensureSession(input.root, `Decision: ${decision}`);
    state.decisions += 1;
    this.addTask(state, `Decision: ${decision}`);
    for (const file of input.files ?? []) {
      if (state.files.size >= this.maxFiles) break;
      if (file.trim()) state.files.add(file.trim());
    }
    await this.options.client.remember({
      content: truncate([
        "Architectural decision recorded by LCA.",
        `Decision: ${decision}`,
        `Rationale: ${why}`,
        `Recorded: ${this.now().toISOString()}`
      ].join("\n"), this.maxSummaryChars),
      project: state.project,
      type: "fact",
      concepts: ["architectural-decision", "lca-decision", toConcept(decision)],
      files: [...new Set(input.files ?? [])]
    });
  }

  private async closeAll(): Promise<void> {
    await Promise.all([...this.pendingSessions.values()].map((pending) => pending.catch(() => undefined)));
    await this.queue;
    const states = [...this.sessions.values()];
    this.sessions.clear();

    for (const state of states) {
      const summary = this.buildSummary(state);
      try {
        if (summary) {
          await this.options.client.remember({
            content: summary,
            project: state.project,
            type: "session_summary",
            concepts: ["lca-session", "tool-usage", ...state.tasks.slice(0, 3).map(toConcept)],
            files: [...state.files]
          });
        }
      } finally {
        await this.options.client.endSession(state.sessionId).catch(() => undefined);
      }
    }
  }

  private buildSummary(state: SessionState): string {
    const tools = [...state.toolCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([tool, count]) => `${tool}:${count}`)
      .join(", ");
    const tasks = state.tasks.length ? state.tasks.map((task) => `- ${task}`).join("\n") : "- No explicit task title captured.";
    const files = state.files.size ? [...state.files].join(", ") : "none captured";
    return truncate([
      `LCA session summary for ${state.project}.`,
      `Started: ${state.startedAt}`,
      `Observations: ${state.observations}; decisions: ${state.decisions}; failures: ${state.failures}.`,
      `Tools: ${tools || "none"}.`,
      "Tasks:",
      tasks,
      `Files: ${files}.`
    ].join("\n"), this.maxSummaryChars);
  }

  private addTask(state: SessionState, task: string | undefined): void {
    const value = task?.trim();
    if (!value || state.tasks.includes(value) || state.tasks.length >= this.maxTasks) return;
    state.tasks.push(value);
  }
}

export class SessionAwareMemoryPort implements MemoryPort {
  constructor(
    private readonly sessions: AgentMemorySessionManager,
    private readonly memory: MemoryPort
  ) {}

  async recall(request: TaskContextRequest): Promise<readonly ContextEvidence[]> {
    await this.sessions.ensureSession(request.root, request.task);
    return this.memory.recall(request);
  }
}

function normalizeRoot(root: string): string {
  return path.resolve(root);
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function toConcept(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "task";
}

function parseLcaSessionPid(sessionId: string): number | undefined {
  const match = /^lca-(\d+)-/.exec(sessionId);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
