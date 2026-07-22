import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpTextContent {
  type: string;
  text?: string;
}

export interface McpToolCallResult {
  content?: readonly McpTextContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpToolConnection {
  callTool(input: {
    name: string;
    arguments: Readonly<Record<string, unknown>>;
  }): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

export type McpConnectionFactory = () => Promise<McpToolConnection>;

export class PersistentMcpToolClient {
  private connection: McpToolConnection | undefined;
  private connectionPromise: Promise<McpToolConnection> | undefined;

  constructor(private readonly connect: McpConnectionFactory) {}

  async callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<McpToolCallResult> {
    const connection = await this.ensureConnection();

    try {
      return await connection.callTool({ name, arguments: args });
    } catch (error) {
      if (!isRetryableTransportError(error)) throw error;
      await this.invalidate(connection);
      const replacement = await this.ensureConnection();
      return replacement.callTool({ name, arguments: args });
    }
  }

  async close(): Promise<void> {
    const current = this.connection;
    this.connection = undefined;
    this.connectionPromise = undefined;
    if (current) await current.close().catch(() => undefined);
  }

  private async ensureConnection(): Promise<McpToolConnection> {
    if (this.connection) return this.connection;
    if (this.connectionPromise) return this.connectionPromise;

    this.connectionPromise = this.connect()
      .then((connection) => {
        this.connection = connection;
        return connection;
      })
      .finally(() => {
        this.connectionPromise = undefined;
      });

    return this.connectionPromise;
  }

  private async invalidate(connection: McpToolConnection): Promise<void> {
    if (this.connection === connection) this.connection = undefined;
    await connection.close().catch(() => undefined);
  }
}

export interface StdioMcpConnectionOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  clientName: string;
  clientVersion: string;
}

export async function createStdioMcpConnection(
  options: StdioMcpConnectionOptions
): Promise<McpToolConnection> {
  const client = new Client({ name: options.clientName, version: options.clientVersion });
  const transport = new StdioClientTransport({
    command: options.command,
    args: [...(options.args ?? [])],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: { ...options.env } } : {}),
    stderr: "pipe"
  });
  transport.stderr?.on("data", () => undefined);
  await client.connect(transport);

  return {
    async callTool(input) {
      return (await client.callTool(input)) as McpToolCallResult;
    },
    async close() {
      await client.close();
    }
  };
}

function isRetryableTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /closed|disconnect|connection|econn|broken pipe|transport|socket/i.test(message);
}
