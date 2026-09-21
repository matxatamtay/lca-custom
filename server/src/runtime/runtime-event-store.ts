import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { RuntimeEvent, RuntimeEventInput } from "./runtime-event.js";

export interface RuntimeEventQuery {
  correlationId?: string;
  sessionId?: string;
  conversationId?: string;
  typePrefix?: string;
  sinceSeq?: number;
  limit?: number;
}

export interface RuntimeEventStoreOptions {
  path: string;
  now?: () => Date;
  createId?: () => string;
  maxInMemory?: number;
}

export class RuntimeEventStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly maxInMemory: number;
  private events: RuntimeEvent[] = [];
  private nextSeq = 1;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RuntimeEventStoreOptions) {
    this.filePath = path.resolve(options.path);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.maxInMemory = Math.max(100, options.maxInMemory ?? 20_000);
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const text = await readFile(this.filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const loaded: RuntimeEvent[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as RuntimeEvent;
        if (validEvent(event)) loaded.push(event);
      } catch {
        // Ignore a torn final line after a crash; earlier append-only events remain usable.
      }
    }
    loaded.sort((left, right) => left.seq - right.seq);
    this.events = loaded.slice(-this.maxInMemory);
    this.nextSeq = (loaded.at(-1)?.seq ?? 0) + 1;
  }

  append(input: RuntimeEventInput): Promise<RuntimeEvent> {
    let resolveEvent!: (event: RuntimeEvent) => void;
    let rejectEvent!: (error: unknown) => void;
    const result = new Promise<RuntimeEvent>((resolve, reject) => {
      resolveEvent = resolve;
      rejectEvent = reject;
    });
    const operation = this.queue.then(async () => {
      const event = snapshotEvent(input, this.nextSeq++, this.now(), this.createId());
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
      this.events.push(event);
      if (this.events.length > this.maxInMemory) this.events.splice(0, this.events.length - this.maxInMemory);
      resolveEvent(event);
    });
    this.queue = operation.catch((error) => {
      rejectEvent(error);
    });
    return result;
  }

  query(query: RuntimeEventQuery = {}): RuntimeEvent[] {
    const limit = Math.max(1, Math.min(10_000, query.limit ?? 500));
    return this.events
      .filter((event) => query.correlationId === undefined || event.correlationId === query.correlationId)
      .filter((event) => query.sessionId === undefined || event.sessionId === query.sessionId)
      .filter((event) => query.conversationId === undefined || event.conversationId === query.conversationId)
      .filter((event) => query.typePrefix === undefined || event.type.startsWith(query.typePrefix))
      .filter((event) => query.sinceSeq === undefined || event.seq > query.sinceSeq)
      .slice(-limit)
      .map((event) => structuredClone(event));
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  get path(): string {
    return this.filePath;
  }
}

function snapshotEvent(input: RuntimeEventInput, seq: number, now: Date, id: string): RuntimeEvent {
  const data = JSON.parse(JSON.stringify(input.data ?? {})) as Record<string, unknown>;
  return {
    seq,
    id,
    timestamp: now.toISOString(),
    type: input.type,
    correlationId: input.correlationId?.trim() || id,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    data
  };
}

function validEvent(value: RuntimeEvent): boolean {
  return Boolean(
    value
    && Number.isSafeInteger(value.seq)
    && value.seq > 0
    && typeof value.id === "string"
    && typeof value.timestamp === "string"
    && typeof value.type === "string"
    && typeof value.correlationId === "string"
    && value.data
    && typeof value.data === "object"
  );
}
