import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export const KNOWN_RUNTIME_EVENT_TYPES = Object.freeze([
  "tool/started",
  "tool/completed",
  "tool/failed"
] as const);

export interface RuntimeEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  seq: number;
  id: string;
  timestamp: string;
  type: string;
  correlationId: string;
  sessionId?: string;
  conversationId?: string;
  parentId?: string;
  data: T;
}

export interface RuntimeEventInput<T extends Record<string, unknown> = Record<string, unknown>> {
  type: string;
  correlationId?: string;
  sessionId?: string;
  conversationId?: string;
  parentId?: string;
  data?: T;
}

export class RuntimeCorrelationScope {
  private readonly storage = new AsyncLocalStorage<string>();

  current(): string | undefined {
    return this.storage.getStore();
  }

  run<T>(correlationId: string | undefined, callback: () => T): T {
    return this.storage.run(correlationId?.trim() || randomUUID(), callback);
  }

  ensure(): string {
    return this.current() ?? randomUUID();
  }
}

export class RuntimeSpanScope {
  private readonly storage = new AsyncLocalStorage<string>();

  current(): string | undefined {
    return this.storage.getStore();
  }

  run<T>(spanId: string, callback: () => T): T {
    return this.storage.run(spanId, callback);
  }
}
