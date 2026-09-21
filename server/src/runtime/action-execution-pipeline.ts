import { performance } from "node:perf_hooks";

import { RuntimeCorrelationScope } from "./runtime-event.js";
import type { RuntimeEventStore } from "./runtime-event-store.js";

export interface ActionExecutionRequest {
  name: string;
  surface: "facade" | "backend" | "runtime";
  args?: unknown;
  correlationId?: string;
  sessionId?: string;
  conversationId?: string;
  parentId?: string;
  resultIsError?: (result: unknown) => boolean;
}

export interface ActionExecutionObservation<T = unknown> {
  name: string;
  surface: ActionExecutionRequest["surface"];
  correlationId: string;
  startedAt: string;
  durationMs: number;
  success: boolean;
  inChars: number;
  outChars: number;
  args: unknown;
  result?: T | undefined;
  error?: unknown;
}

export type ActionExecutionObserver = (observation: ActionExecutionObservation) => void | Promise<void>;

export class ActionExecutionPipeline {
  private readonly observers = new Set<ActionExecutionObserver>();

  constructor(
    private readonly events: RuntimeEventStore,
    private readonly correlations = new RuntimeCorrelationScope()
  ) {}

  subscribe(observer: ActionExecutionObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  execute<T>(request: ActionExecutionRequest, action: () => Promise<T> | T): Promise<T> {
    const inherited = request.correlationId?.trim() || this.correlations.current();
    return this.correlations.run(inherited, async () => {
      const correlationId = this.correlations.ensure();
      const startedAt = new Date().toISOString();
      const startedMs = performance.now();
      const inChars = jsonChars(request.args ?? {});
      const startedWrite = this.events.append({
        type: "tool/started",
        correlationId,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        ...(request.parentId ? { parentId: request.parentId } : {}),
        data: { name: request.name, surface: request.surface, inChars }
      }).catch(() => undefined);
      try {
        const result = await action();
        const success = !request.resultIsError?.(result);
        const observation = observe(request, correlationId, startedAt, startedMs, inChars, success, result);
        await this.events.append({
          type: success ? "tool/completed" : "tool/failed",
          correlationId,
          data: durableObservation(observation)
        });
        await startedWrite;
        this.notify(observation);
        return result;
      } catch (error) {
        const observation = observe(request, correlationId, startedAt, startedMs, inChars, false, undefined, error);
        await this.events.append({
          type: "tool/failed",
          correlationId,
          data: durableObservation(observation)
        }).catch(() => undefined);
        await startedWrite;
        this.notify(observation);
        throw error;
      }
    });
  }

  currentCorrelationId(): string | undefined {
    return this.correlations.current();
  }

  private notify(observation: ActionExecutionObservation): void {
    for (const observer of this.observers) {
      Promise.resolve(observer(observation)).catch(() => undefined);
    }
  }
}

function observe<T>(
  request: ActionExecutionRequest,
  correlationId: string,
  startedAt: string,
  startedMs: number,
  inChars: number,
  success: boolean,
  result?: T,
  error?: unknown
): ActionExecutionObservation<T> {
  const outChars = result !== undefined
    ? jsonChars(result)
    : String(error instanceof Error ? error.message : error ?? "").length;
  return {
    name: request.name,
    surface: request.surface,
    correlationId,
    startedAt,
    durationMs: Math.max(0, Math.round((performance.now() - startedMs) * 10) / 10),
    success,
    inChars,
    outChars,
    args: request.args ?? {},
    ...(success ? { result } : { error })
  };
}

function durableObservation(observation: ActionExecutionObservation): Record<string, unknown> {
  return {
    name: observation.name,
    surface: observation.surface,
    success: observation.success,
    durationMs: observation.durationMs,
    inChars: observation.inChars,
    outChars: observation.outChars,
    ...(observation.error ? { error: String(observation.error instanceof Error ? observation.error.message : observation.error).slice(0, 500) } : {})
  };
}

function jsonChars(value: unknown): number {
  try { return JSON.stringify(value)?.length ?? 0; } catch { return 0; }
}
