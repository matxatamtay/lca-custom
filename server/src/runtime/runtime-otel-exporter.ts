import { createHash } from "node:crypto";

import type { ActionExecutionObservation } from "./action-execution-pipeline.js";

export interface RuntimeOtelExporterOptions {
  endpoint?: string;
  serviceName?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class RuntimeOtelExporter {
  private readonly endpoint: string | undefined;
  private readonly serviceName: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RuntimeOtelExporterOptions = {}) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.serviceName = options.serviceName?.trim() || "local-coding-agent";
    this.timeoutMs = Math.max(500, Math.min(10_000, options.timeoutMs ?? 3_000));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get enabled(): boolean {
    return Boolean(this.endpoint);
  }

  async observe(observation: ActionExecutionObservation): Promise<void> {
    if (!this.endpoint) return;
    const startNs = BigInt(Date.parse(observation.startedAt)) * 1_000_000n;
    const durationNs = BigInt(Math.max(0, Math.round(observation.durationMs * 1_000_000)));
    const payload = {
      resourceSpans: [{
        resource: {
          attributes: [attribute("service.name", this.serviceName)]
        },
        scopeSpans: [{
          scope: { name: "local-coding-agent/runtime" },
          spans: [{
            traceId: hashHex(observation.correlationId, 32),
            spanId: hashHex(`${observation.correlationId}:${observation.startedAt}:${observation.name}`, 16),
            name: observation.name,
            kind: 1,
            startTimeUnixNano: startNs.toString(),
            endTimeUnixNano: (startNs + durationNs).toString(),
            attributes: [
              attribute("lca.surface", observation.surface),
              attribute("lca.success", observation.success),
              attribute("lca.input_chars", observation.inChars),
              attribute("lca.output_chars", observation.outChars)
            ],
            status: { code: observation.success ? 1 : 2 }
          }]
        }]
      }]
    };
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error(`OTLP trace export failed with HTTP ${response.status}.`);
  }
}

function normalizeEndpoint(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OTLP endpoint must use http or https.");
  }
  if (!url.pathname.endsWith("/v1/traces")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/traces`.replace(/\/+/g, "/");
  }
  return url.toString();
}

function hashHex(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function attribute(key: string, value: string | number | boolean) {
  const field = typeof value === "boolean"
    ? { boolValue: value }
    : typeof value === "number" ? { intValue: String(Math.round(value)) } : { stringValue: value };
  return { key, value: field };
}
