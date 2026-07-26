import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import type { ContextEvidence, TaskContextRequest } from "../../domain/task-context.js";
import type { CodeIntelligencePort } from "../../ports/context-providers.js";
import {
  PersistentMcpToolClient,
  createStdioMcpConnection
} from "../../infrastructure/mcp/persistent-mcp-tool-client.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export interface CodeGraphIndexer {
  ensureIndexed(root: string): Promise<void>;
}

export interface CodeGraphAdapterOptions {
  client: PersistentMcpToolClient;
  indexer: CodeGraphIndexer;
}

export class CodeGraphAdapter implements CodeIntelligencePort {
  constructor(private readonly options: CodeGraphAdapterOptions) {}

  ensureIndexed(root: string): Promise<void> {
    return this.options.indexer.ensureIndexed(root);
  }

  close(): Promise<void> {
    return this.options.client.close();
  }

  async context(request: TaskContextRequest): Promise<readonly ContextEvidence[]> {
    const maxFiles = Math.max(1, Math.min(24, request.budget?.maxItems ?? 12));
    const query = [request.task, ...(request.changedFiles ?? [])].join(" ").trim();
    const projectPath = path.resolve(request.root);
    const result = await this.options.client.callTool("codegraph_explore", {
      query,
      projectPath,
      maxFiles
    });

    if (result.isError) {
      throw new Error(extractText(result) || "CodeGraph exploration failed.");
    }

    const content = extractText(result).trim();
    if (!content) return [];
    const boundedContent = request.budget?.maxChars
      ? content.slice(0, request.budget.maxChars)
      : content;

    return [{
      id: `codegraph-${shortHash(`${projectPath}\u0000${query}\u0000${boundedContent}`)}`,
      provider: "codegraph",
      kind: "relationship",
      title: `CodeGraph exploration: ${request.task}`,
      content: boundedContent,
      score: 90,
      metadata: {
        tool: "codegraph_explore",
        maxFiles,
        truncated: boundedContent.length < content.length
      }
    }];
  }
}

export interface CodeGraphCliIndexerOptions {
  command: string;
  prefixArgs?: readonly string[];
  env?: Readonly<Record<string, string>>;
  syncTtlMs?: number;
}

export class CodeGraphCliIndexer implements CodeGraphIndexer {
  private readonly lastSyncByRoot = new Map<string, number>();
  private readonly syncTtlMs: number;

  constructor(private readonly options: CodeGraphCliIndexerOptions) {
    this.syncTtlMs = options.syncTtlMs ?? 5_000;
  }

  async ensureIndexed(root: string): Promise<void> {
    const normalizedRoot = path.resolve(root);
    const lastSync = this.lastSyncByRoot.get(normalizedRoot) ?? 0;
    if (Date.now() - lastSync < this.syncTtlMs) return;

    const databasePath = path.join(normalizedRoot, ".codegraph", "codegraph.db");
    const initialized = await exists(databasePath);
    const args = initialized
      ? [...(this.options.prefixArgs ?? []), "sync", "--quiet", normalizedRoot]
      : [...(this.options.prefixArgs ?? []), "init", normalizedRoot];

    await execFileAsync(this.options.command, args, {
      cwd: normalizedRoot,
      env: {
        ...process.env,
        CODEGRAPH_TELEMETRY: "0",
        ...(this.options.env ?? {})
      },
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    });
    this.lastSyncByRoot.set(normalizedRoot, Date.now());
  }
}

export function createDefaultCodeGraphAdapter(): CodeGraphAdapter {
  const packageJson = require.resolve("@colbymchenry/codegraph/package.json");
  const shimPath = path.join(path.dirname(packageJson), "npm-shim.js");
  const command = process.execPath;
  const prefixArgs = [shimPath];
  const client = new PersistentMcpToolClient(() => createStdioMcpConnection({
    command,
    args: [...prefixArgs, "serve", "--mcp"],
    cwd: process.cwd(),
    env: { ...process.env, CODEGRAPH_TELEMETRY: "0" },
    clientName: "lca-codegraph-adapter",
    clientVersion: "0.1.0"
  }));

  return new CodeGraphAdapter({
    client,
    indexer: new CodeGraphCliIndexer({ command, prefixArgs })
  });
}

function extractText(result: { content?: readonly { type: string; text?: string }[] }): string {
  return (result.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("\n");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
