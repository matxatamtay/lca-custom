export type AgentSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type AgentIsolationMode = "shared" | "worktree";

export interface AgentTaskSpec {
  task: string;
  name?: string;
  cwd: string;
  files?: readonly string[];
  context?: string;
  model?: string;
  provider?: string;
  providerChain?: readonly string[];
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  sandbox?: AgentSandboxMode;
  isolation?: AgentIsolationMode;
  inheritDirty?: boolean;
  networkAccess?: boolean;
  additionalDirectories?: readonly string[];
}

export interface AgentJobSummary {
  id: string;
  status: "queued" | "running" | "stopping" | "completed" | "failed" | "cancelled";
  task: string;
  cwd: string;
  changedFiles: readonly string[];
}

export interface AgentMergeResult {
  ok: boolean;
  applied: boolean;
  conflict: boolean;
  changedFiles: readonly string[];
}

/**
 * Runtime-neutral model-agent boundary. Concrete adapters may use Codex,
 * another hosted coding agent, or a local model without changing orchestration.
 */
export interface AgentRunnerPort {
  readonly name: string;
  spawn(task: AgentTaskSpec): Promise<AgentJobSummary> | AgentJobSummary;
  list(): Promise<readonly AgentJobSummary[]> | readonly AgentJobSummary[];
  collect(jobIds: readonly string[]): Promise<readonly AgentJobSummary[]> | readonly AgentJobSummary[];
  stop(jobId: string): Promise<AgentJobSummary> | AgentJobSummary;
  merge?(jobId: string): Promise<AgentMergeResult> | AgentMergeResult;
  cleanup?(jobId: string): Promise<unknown> | unknown;
}
