// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
  rename,
  rm,
  appendFile,
  access,
  copyFile,
  cp
} from "node:fs/promises";
import { createWriteStream, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConversationRuntimeContext } from "./dist/orchestration/conversation-runtime-context.js";
import { ActionExecutionPipeline } from "./dist/runtime/action-execution-pipeline.js";
import { RuntimeEventStore } from "./dist/runtime/runtime-event-store.js";
import { RuntimeOtelExporter } from "./dist/runtime/runtime-otel-exporter.js";
import { RuntimePluginHost } from "./dist/runtime/runtime-plugin.js";
import { summarizeArgs } from "./core/redaction.mjs";
import {
  appendLimited, boundedNumber, comparePath, dedupe, firstText, hasCommand, isoNow,
  parseExtraRoots, resultLen, trimOutput
} from "./core/runtime-utils.mjs";
import { createNotesSkills } from "./core/notes-skills.mjs";
import { createFilesystemCore } from "./core/filesystem-core.mjs";
import { createCommandRuntime } from "./core/command-runtime.mjs";
import { createExecAccelerator } from "./core/exec-accelerator.mjs";
import { createProjectIntelligence } from "./core/project-intelligence.mjs";
import { resolveActiveProjectRoot as discoverActiveProjectRoot } from "./core/project-root-discovery.mjs";
import { createRepoIndexCore } from "./core/repo-index-core.mjs";
import { createVerificationCore } from "./core/verification-core.mjs";
import { createPatchCore } from "./core/patch-core.mjs";
import { createEditTransactionCore } from "./core/edit-transaction.mjs";
import { createPostEditIntelligence } from "./core/post-edit-intelligence.mjs";
import { createChangeAwareVerification } from "./core/change-aware-verification.mjs";
import { cleanupOrphanAtomicTemps, createTransactionJournal } from "./core/runtime-recovery.mjs";
import { createWorkspaceStateRegistry } from "./core/workspace-state-registry.mjs";
import { createWorktreeCore } from "./core/worktree-core.mjs";
import { createTestCore } from "./core/test-core.mjs";
import { createWorkspaceProfile } from "./core/workspace-profile.mjs";
import { createHttpRuntime } from "./core/http-runtime.mjs";
import { createAgentMemoryObservation } from "./core/agentmemory-observation.mjs";
import { createPerformanceTelemetry, modelVisibleResultBytes, telemetryPathCandidates } from "./core/performance-telemetry.mjs";
import { createPerformanceFollow } from "./core/performance-follow.mjs";
import {
  DEFAULT_FIGMA_DESKTOP_MCP_URL,
  callFigmaDesktopTool,
  closeFigmaDesktopClients,
  figmaDesktopStatus,
  listFigmaDesktopTools,
  parseFigmaNodeReference
} from "./figma-desktop.mjs";
import {
  DEFAULT_FIGMA_REMOTE_MCP_URL,
  DEFAULT_FIGMA_REMOTE_TOKEN_PATH,
  callFigmaRemoteTool,
  closeFigmaRemoteClients,
  figmaRemoteStatus,
  finishFigmaRemoteAuthorization,
  listFigmaRemoteTools,
  resetFigmaRemoteAuthorization,
  startFigmaRemoteAuthorization
} from "./figma-remote.mjs";
import {
  DEFAULT_DBEAVER_DESKTOP_MCP_URL,
  callDBeaverDesktopTool,
  callReadOnlyDBeaverDesktopTool,
  closeDBeaverDesktopClients,
  dbeaverDesktopStatus,
  listDBeaverDesktopTools
} from "./dbeaver-desktop.mjs";
import {
  DEFAULT_BRUNO_DESKTOP_MCP_URL,
  brunoDesktopStatus,
  callBrunoDesktopTool,
  closeBrunoDesktopClients,
  listBrunoDesktopTools
} from "./bruno-desktop.mjs";
import {
  DEFAULT_PENPOT_MCP_URL,
  callDestructivePenpotTool,
  callMutatingPenpotTool,
  callPenpotTool,
  callReadOnlyPenpotTool,
  closePenpotClients,
  inspectPenpotPage,
  inspectPenpotSelection,
  listPenpotTools,
  penpotStatus
} from "./penpot-desktop.mjs";
import {
  DEFAULT_COOLIFY_BASE_URL,
  callCoolifyMcpTool,
  callDestructiveCoolifyMcpTool,
  callMutatingCoolifyMcpTool,
  callReadOnlyCoolifyMcpTool,
  closeCoolifyMcpClients,
  coolifyMcpStatus,
  listCoolifyMcpTools
} from "./coolify-mcp.mjs";
import { resolveTaskProjectRoot } from "./project-routing.mjs";
import { createFigmaToolRegistrar } from "./integrations/figma-tools.mjs";
import { createDBeaverToolRegistrar } from "./integrations/dbeaver-tools.mjs";
import { createBrunoToolRegistrar } from "./integrations/bruno-tools.mjs";
import { createCoolifyToolRegistrar } from "./integrations/coolify-tools.mjs";
import { createCompanionContextSearch } from "./companion/context-search.mjs";
import { createCompanionMcp } from "./companion/mcp-tools.mjs";
import { createRepoIntelToolRegistrar } from "./tools/repo-intel-tools.mjs";
import { createTestRunnerToolRegistrar } from "./tools/test-runner-tools.mjs";
import { createReviewToolRegistrar } from "./tools/review-tools.mjs";
import { createPlannerToolRegistrar } from "./tools/planner-tools.mjs";
import { createSkillToolRegistrar } from "./tools/skill-tools.mjs";
import { createBasicToolRegistrar } from "./tools/basic-tools.mjs";
import { createFsReadToolRegistrar } from "./tools/fs-read-tools.mjs";
import { createFsWriteToolRegistrar } from "./tools/fs-write-tools.mjs";
import { createExecToolRegistrar } from "./tools/exec-tools.mjs";
import { createProcessToolRegistrar } from "./tools/process-tools.mjs";
import { createGitToolRegistrar } from "./tools/git-tools.mjs";
import { createPatchEngineToolRegistrar } from "./tools/patch-engine-tools.mjs";

// ----------------------------------------------------------------------------
// Configuration (all overridable via environment variables)
// ----------------------------------------------------------------------------
const VERSION = "4.4.0-pro";
const PRODUCT_TIER = "pro";
const TOOL_METRICS = new ToolMetrics({ recentLimit: 500 });
const PORT = Number(process.env.PORT || 8790);
// Bind to loopback by default. The local OpenAI tunnel-client forwards to this,
// so we never need to listen on 0.0.0.0 (which would expose a shell to the LAN).
const HOST = process.env.AGENT_HOST || "127.0.0.1";

const CONFIG_ID = String(process.env.AGENT_CONFIG_ID || "");

function loadRequiredHtmlResource(filePath, label) {
  try {
    const text = readFileSync(filePath, "utf8");
    if (!/<html(?:\s|>)/i.test(text) || !/<\/html>/i.test(text)) {
      throw new Error("file is not a complete HTML document");
    }
    return Object.freeze({
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      sha256: createHash("sha256").update(text).digest("hex")
    });
  } catch (error) {
    throw new Error(`Required ${label} app resource is unavailable at ${filePath}: ${error?.message || error}`);
  }
}

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
let nextApplicationRuntimePromise;

async function getNextApplicationRuntime() {
  if (!nextApplicationRuntimePromise) {
    nextApplicationRuntimePromise = import("./dist/bootstrap/default-container.js")
      .then(({ createDefaultApplicationContainer }) => createDefaultApplicationContainer({
        agentMemoryUrl: process.env.AGENTMEMORY_URL || "http://127.0.0.1:3111",
        agentMemorySecret: process.env.AGENTMEMORY_SECRET || undefined,
        jevEnabled: process.env.JEV_ENABLED !== "0",
        jevApiToken: process.env.JEV_API_TOKEN || process.env.TYPESAFE_API_KEY || undefined,
        jevEndpoint: process.env.JEV_API_URL || undefined,
        jevModel: process.env.JEV_MODEL || undefined,
        jevTimeoutMs: process.env.JEV_TIMEOUT_MS ? Number(process.env.JEV_TIMEOUT_MS) : undefined,
        jevMaxCandidates: process.env.JEV_MAX_CANDIDATES ? Number(process.env.JEV_MAX_CANDIDATES) : undefined,
        jevMaxStateChars: process.env.JEV_MAX_STATE_CHARS ? Number(process.env.JEV_MAX_STATE_CHARS) : undefined
      }))
      .catch((error) => {
        nextApplicationRuntimePromise = undefined;
        throw error;
      });
  }
  return nextApplicationRuntimePromise;
}

async function closeNextApplicationRuntime() {
  const pending = nextApplicationRuntimePromise;
  nextApplicationRuntimePromise = undefined;
  if (!pending) {
    await lifecycleLog("next runtime close skipped: runtime was never created");
    return;
  }
  await lifecycleLog("next runtime close started");
  const runtime = await pending;
  await runtime.close();
  await lifecycleLog("next runtime close completed");
}
const COMPANION_WIDGET_PATH = path.join(APP_DIR, "lca-compact-input-v2.html");
const COMPANION_WIDGET_LEGACY_URI = "ui://widget/lca-compact-input-v2.html";
const DBEAVER_SQL_ARTIFACT_PATH = path.join(APP_DIR, "dbeaver-sql-artifact.html");
const NOTION_PAGE_WIDGET_PATH = path.join(APP_DIR, "notion-page.html");
const NOTION_PAGE_WIDGET_LEGACY_URI = "ui://widget/lca-notion-page.html";
const NOTION_PAGE_WIDGET_MIME_TYPE = "text/html;profile=mcp-app";
const NOTION_PAGE_WIDGET_RUNTIME_KEY = "mcp-app-v1";
const COMPANION_WIDGET_RESOURCE = loadRequiredHtmlResource(COMPANION_WIDGET_PATH, "LCA companion widget");
const COMPANION_WIDGET_URI = `ui://widget/lca-compact-input-v2-${COMPANION_WIDGET_RESOURCE.sha256.slice(0, 12)}.html`;
const DBEAVER_SQL_ARTIFACT_RESOURCE = loadRequiredHtmlResource(DBEAVER_SQL_ARTIFACT_PATH, "DBeaver SQL artifact");
const DBEAVER_SQL_ARTIFACT_URI = `ui://widget/dbeaver-sql-artifact-${DBEAVER_SQL_ARTIFACT_RESOURCE.sha256.slice(0, 12)}.html`;
const DBEAVER_SQL_ARTIFACT_LEGACY_URI = "ui://widget/dbeaver-sql-artifact.html";
const NOTION_PAGE_WIDGET_RESOURCE = loadRequiredHtmlResource(NOTION_PAGE_WIDGET_PATH, "Notion page widget");
const NOTION_PAGE_WIDGET_URI = `ui://widget/lca-notion-page-${NOTION_PAGE_WIDGET_RESOURCE.sha256.slice(0, 12)}-${NOTION_PAGE_WIDGET_RUNTIME_KEY}.html`;
const DEFAULT_WORKSPACE = path.resolve(APP_DIR, "..", "agent-workspace");
const PRIMARY_ROOT = path.resolve(process.env.AGENT_WORKSPACE || DEFAULT_WORKSPACE);
const STARTUP_PROFILE = (() => {
  try {
    return JSON.parse(readFileSync(path.join(PRIMARY_ROOT, ".agent", "profile.json"), "utf8"));
  } catch {
    return null;
  }
})();
const EXTRA_ROOTS = parseExtraRoots(STARTUP_PROFILE);
const ROOTS = dedupe([PRIMARY_ROOT, ...EXTRA_ROOTS]);
const CONVERSATION_RUNTIME = new ConversationRuntimeContext({
  primaryRoot: PRIMARY_ROOT,
  roots: ROOTS,
  runner: "codex",
  isolation: "worktree",
  networkAccess: true
});

function activePrimaryRoot() {
  return CONVERSATION_RUNTIME.primaryRoot();
}

function activeDiscoveryRoots() {
  return CONVERSATION_RUNTIME.discoveryRoots();
}

// LCA is a trusted local execution engine. Project roots drive discovery and
// relative-path routing; they are not authorization boundaries.
const TOOL_SURFACE = "compact";
const RECORD_AGENTMEMORY_SESSIONS = process.env.AGENTMEMORY_RECORD_SESSIONS !== "0";

// Optional defense-in-depth bearer token. If set, every /mcp request must send
// Authorization: Bearer <token>. Leave empty when relying on the
// OpenAI Secure MCP Tunnel, whose channel is already private to your account.
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const ALLOWED_ORIGINS = new Set(
  String(process.env.MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const DATA_DIR = path.resolve(APP_DIR, "data");
const WORKTREE_BASE_DIR = path.resolve(DATA_DIR, "worktrees");
const LIFECYCLE_LOG_PATH = path.join(DATA_DIR, "lifecycle.log");
const WORKSPACE_ID = createHash("sha256").update(comparePath(PRIMARY_ROOT)).digest("hex").slice(0, 16);
const WORKSPACE_DATA_DIR = path.join(DATA_DIR, "workspaces", WORKSPACE_ID);
const RUNTIME_EVENT_PATH = path.join(WORKSPACE_DATA_DIR, "runtime", "events.jsonl");
const RUNTIME_EVENTS = new RuntimeEventStore({ path: RUNTIME_EVENT_PATH, maxInMemory: 30_000 });
await RUNTIME_EVENTS.init();
const ACTION_PIPELINE = new ActionExecutionPipeline(RUNTIME_EVENTS);
ACTION_PIPELINE.subscribe(consumeActionObservation);
const OTEL_EXPORTER = new RuntimeOtelExporter({
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  serviceName: process.env.OTEL_SERVICE_NAME || "local-coding-agent"
});
ACTION_PIPELINE.subscribe((observation) => OTEL_EXPORTER.observe(observation));
const RUNTIME_PLUGIN_HOST = new RuntimePluginHost({
  runtime: CONVERSATION_RUNTIME,
  events: RUNTIME_EVENTS
});
await RUNTIME_PLUGIN_HOST.mount({
  name: "integration-clients",
  start: () => ({
    dispose: async () => {
      await closeNextApplicationRuntime();
      await closeLegacyBackendRuntime();
      await Promise.all([
        closeFigmaDesktopClients(),
        closeDBeaverDesktopClients(),
        closeBrunoDesktopClients(),
        closePenpotClients(),
        closeCoolifyMcpClients(),
        closeBrowserAgentClient()
      ]);
    }
  })
});
const NOTES_PATH = path.resolve(WORKSPACE_DATA_DIR, "notes.json");
const CHECKPOINT_PATH = path.resolve(WORKSPACE_DATA_DIR, "checkpoint.json");
const TRANSACTION_JOURNAL_PATH = path.resolve(WORKSPACE_DATA_DIR, "transaction-journal.json");
const AUDIT_PATH = path.resolve(DATA_DIR, "audit.log");
const PERFORMANCE_TELEMETRY_PATH = path.resolve(WORKSPACE_DATA_DIR, "performance-telemetry.json");
const PERFORMANCE_FOLLOW_PATH = path.resolve(WORKSPACE_DATA_DIR, "performance-follow.json");
const AUDIT_ENABLED = process.env.AGENT_AUDIT !== "0";
const AUDIT_ARGS = process.env.AGENT_AUDIT_ARGS !== "0";
const HTTP_LOG = process.env.AGENT_HTTP_LOG === "1";

// Figma Desktop exposes a local MCP server after the user enables it in Dev Mode.
// LCA acts as an MCP client and forwards results without managing Figma tokens.
const FIGMA_DESKTOP_MCP_URL = String(process.env.FIGMA_DESKTOP_MCP_URL || DEFAULT_FIGMA_DESKTOP_MCP_URL).trim();
const FIGMA_DESKTOP_TIMEOUT_MS = boundedNumber(process.env.FIGMA_DESKTOP_TIMEOUT_MS, 30_000, 1_000, 120_000);
const FIGMA_REMOTE_ENABLED = process.env.FIGMA_REMOTE_ENABLED === "1";
const FIGMA_REMOTE_MCP_URL = String(process.env.FIGMA_REMOTE_MCP_URL || DEFAULT_FIGMA_REMOTE_MCP_URL).trim();
const FIGMA_REMOTE_TIMEOUT_MS = boundedNumber(process.env.FIGMA_REMOTE_TIMEOUT_MS, 60_000, 1_000, 300_000);
const FIGMA_REMOTE_AUTH_TOKEN = String(process.env.FIGMA_REMOTE_AUTH_TOKEN || "").trim();
const FIGMA_REMOTE_CLIENT_ID = String(process.env.FIGMA_REMOTE_CLIENT_ID || "").trim();
const FIGMA_REMOTE_CLIENT_SECRET = String(process.env.FIGMA_REMOTE_CLIENT_SECRET || "").trim();
const FIGMA_REMOTE_ALLOW_WRITE = process.env.FIGMA_REMOTE_ALLOW_WRITE === "1";
const FIGMA_REMOTE_TOKEN_PATH = String(process.env.FIGMA_REMOTE_TOKEN_PATH || DEFAULT_FIGMA_REMOTE_TOKEN_PATH).trim();
const FIGMA_REMOTE_CALLBACK_URL = String(
  process.env.FIGMA_REMOTE_CALLBACK_URL || `http://127.0.0.1:${PORT}/integrations/figma/oauth/callback`
).trim();
const DBEAVER_DESKTOP_MCP_URL = String(process.env.DBEAVER_DESKTOP_MCP_URL || DEFAULT_DBEAVER_DESKTOP_MCP_URL).trim();
const DBEAVER_DESKTOP_TIMEOUT_MS = boundedNumber(process.env.DBEAVER_DESKTOP_TIMEOUT_MS, 45_000, 1_000, 300_000);
const DBEAVER_DESKTOP_AUTH_TOKEN = String(process.env.DBEAVER_DESKTOP_AUTH_TOKEN || "").trim();
const DBEAVER_RUN_INTENT_TTL_MS = boundedNumber(process.env.DBEAVER_RUN_INTENT_TTL_MS, 10 * 60_000, 60_000, 30 * 60_000);
const BRUNO_DESKTOP_MCP_URL = String(process.env.BRUNO_DESKTOP_MCP_URL || DEFAULT_BRUNO_DESKTOP_MCP_URL).trim();
const BRUNO_DESKTOP_TIMEOUT_MS = boundedNumber(process.env.BRUNO_DESKTOP_TIMEOUT_MS, 120_000, 1_000, 300_000);
const BRUNO_DESKTOP_AUTH_TOKEN = String(process.env.BRUNO_DESKTOP_AUTH_TOKEN || "").trim();
const PENPOT_MCP_URL = String(process.env.PENPOT_MCP_URL || DEFAULT_PENPOT_MCP_URL).trim();
const PENPOT_MCP_TIMEOUT_MS = boundedNumber(process.env.PENPOT_MCP_TIMEOUT_MS, 120_000, 1_000, 300_000);
const PENPOT_USER_TOKEN = String(process.env.PENPOT_USER_TOKEN || "").trim();
const COOLIFY_BASE_URL = String(process.env.COOLIFY_BASE_URL || DEFAULT_COOLIFY_BASE_URL).trim();
const COOLIFY_MCP_TIMEOUT_MS = boundedNumber(process.env.COOLIFY_MCP_TIMEOUT_MS, 120_000, 1_000, 300_000);
const COOLIFY_ACCESS_TOKEN = String(process.env.COOLIFY_ACCESS_TOKEN || "").trim();
const NOTION_API_BASE = String(process.env.NOTION_API_BASE || DEFAULT_NOTION_API_BASE).trim();
const NOTION_VERSION = String(process.env.NOTION_VERSION || DEFAULT_NOTION_VERSION).trim();
const NOTION_API_KEY = String(process.env.NOTION_API_KEY || "").trim();
const NOTION_TIMEOUT_MS = boundedNumber(process.env.NOTION_TIMEOUT_MS, 30_000, 1_000, 120_000);



function figmaRemoteBridgeOptions() {
  return {
    endpoint: FIGMA_REMOTE_MCP_URL,
    timeoutMs: FIGMA_REMOTE_TIMEOUT_MS,
    authToken: FIGMA_REMOTE_AUTH_TOKEN,
    clientId: FIGMA_REMOTE_CLIENT_ID,
    clientSecret: FIGMA_REMOTE_CLIENT_SECRET,
    allowWrite: FIGMA_REMOTE_ALLOW_WRITE,
    callbackUrl: FIGMA_REMOTE_CALLBACK_URL,
    tokenPath: FIGMA_REMOTE_TOKEN_PATH
  };
}

const registerFigmaDesktopTools = createFigmaToolRegistrar({
  reg, jsonResult, figmaRemoteBridgeOptions,
  FIGMA_DESKTOP_MCP_URL, FIGMA_DESKTOP_TIMEOUT_MS,
  FIGMA_REMOTE_ENABLED, FIGMA_REMOTE_MCP_URL, FIGMA_REMOTE_ALLOW_WRITE
});
const registerDBeaverDesktopTools = createDBeaverToolRegistrar({
  reg, jsonResult, DBEAVER_DESKTOP_MCP_URL, DBEAVER_DESKTOP_TIMEOUT_MS,
  DBEAVER_DESKTOP_AUTH_TOKEN, DBEAVER_RUN_INTENT_TTL_MS, DBEAVER_SQL_ARTIFACT_URI
});
const registerBrunoDesktopTools = createBrunoToolRegistrar({
  reg, jsonResult, BRUNO_DESKTOP_MCP_URL, BRUNO_DESKTOP_TIMEOUT_MS, BRUNO_DESKTOP_AUTH_TOKEN
});
const registerCoolifyMcpTools = createCoolifyToolRegistrar({
  reg, jsonResult, COOLIFY_MCP_URL, COOLIFY_MCP_TIMEOUT_MS, COOLIFY_MCP_AUTH_TOKEN
});

// v2.1 Repo index cache
const INDEX_PATH = path.resolve(WORKSPACE_DATA_DIR, "index.json");
const REPO_INDEX_TTL_MS = 5 * 60 * 1000; // 5 minutes

// v2.2 Patch history
const PATCH_HISTORY_PATH = path.resolve(WORKSPACE_DATA_DIR, "patch-history.json");
const BACKUPS_DIR = path.resolve(WORKSPACE_DATA_DIR, "backups");

function activePatchDataDir() {
  const scopedRoot = CONVERSATION_RUNTIME.scopedPrimaryRoot();
  if (!scopedRoot) return WORKSPACE_DATA_DIR;
  const scopeId = createHash("sha256").update(comparePath(scopedRoot)).digest("hex").slice(0, 16);
  return path.join(WORKSPACE_DATA_DIR, "conversation-projects", scopeId);
}

function activePatchHistoryPath() {
  return CONVERSATION_RUNTIME.isScoped()
    ? path.join(activePatchDataDir(), "patch-history.json")
    : PATCH_HISTORY_PATH;
}

function activeBackupsDir() {
  return CONVERSATION_RUNTIME.isScoped()
    ? path.join(activePatchDataDir(), "backups")
    : BACKUPS_DIR;
}

// v2.5 Planner state
const AGENT_STATE_DIR = path.join(PRIMARY_ROOT, ".agent", "state");
const TASK_PLAN_PATH = path.join(AGENT_STATE_DIR, "current-task.json");
const DECISIONS_PATH = path.join(AGENT_STATE_DIR, "decisions.md");
const MEMORY_VAULT_PATH = defaultMemoryVault();
const WORKSPACE_PROTOCOL = new WorkspaceProtocol({
  primaryRoot: PRIMARY_ROOT,
  projectId: WORKSPACE_ID,
  stateDir: AGENT_STATE_DIR,
  vaultDir: MEMORY_VAULT_PATH
});

function activeAgentStateDir() {
  const scopedRoot = CONVERSATION_RUNTIME.scopedPrimaryRoot();
  return scopedRoot ? path.join(scopedRoot, ".agent", "state") : AGENT_STATE_DIR;
}

function activeTaskPlanPath() {
  return path.join(activeAgentStateDir(), "current-task.json");
}

function activeDecisionsPath() {
  return path.join(activeAgentStateDir(), "decisions.md");
}

function activeCheckpointPath() {
  const scopedRoot = CONVERSATION_RUNTIME.scopedPrimaryRoot();
  return scopedRoot ? path.join(scopedRoot, ".agent", "state", "checkpoint.json") : CHECKPOINT_PATH;
}

// v2.8 Profile

// Skills: reusable playbooks the agent can load on demand (Claude-style).
// Discovered from: AGENT_SKILLS_DIR (env), the repo's shipped skills/, and each
// workspace root's .claude/skills and .agent/skills.
const SKILLS_DIRS = dedupe([
  ...(process.env.AGENT_SKILLS_DIR ? [path.resolve(process.env.AGENT_SKILLS_DIR)] : []),
  path.resolve(APP_DIR, "..", "skills"),
  ...ROOTS.flatMap((r) => [path.join(r, ".claude", "skills"), path.join(r, ".agent", "skills")])
]);

const MAX_READ_CHARS = Number(process.env.AGENT_MAX_READ_CHARS || 200_000);
// Default (not max) chars returned by read_file — keeps payloads small so the
// ChatGPT UI does not choke on huge file dumps. Callers can raise via max_chars.
const READ_DEFAULT = Number(process.env.AGENT_READ_DEFAULT || 30_000);
const CMD_OUTPUT_DEFAULT = Number(process.env.AGENT_CMD_OUTPUT_DEFAULT || 20_000);
const MAX_COMMAND_OUTPUT = Number(process.env.AGENT_MAX_COMMAND_OUTPUT || 200_000);
const MAX_BATCH_READ_CHARS = boundedNumber(process.env.AGENT_MAX_BATCH_READ_CHARS, 500_000, 10_000, 2_000_000);
const MAX_BODY_BYTES = Number(process.env.AGENT_MAX_BODY_BYTES || 16 * 1024 * 1024);
const DEFAULT_CMD_TIMEOUT = 60_000;
const WORKTREE_GC_MAX_AGE_MS = boundedNumber(process.env.AGENT_WORKTREE_GC_MAX_AGE_MS, 14 * 24 * 60 * 60_000, 60_000, 3650 * 24 * 60 * 60_000);
const MAX_PROCS = 24;
const PROC_BUFFER = 200_000;
const MANIFEST_NAMES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "tsconfig.json",
  "pubspec.yaml",
  "go.mod",
  "cargo.toml",
  "pom.xml",
  "build.gradle",
  "requirements.txt",
  "pyproject.toml",
  "gemfile",
  "composer.json",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "makefile",
  "readme.md",
  ".env.example"
]);

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "__pycache__",
  ...((Array.isArray(STARTUP_PROFILE?.ignoredDirs) ? STARTUP_PROFILE.ignoredDirs : []).map(String))
]);

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------
const processes = new Map(); // id -> { id, name, command, child, status, exitCode, startedAt, stdout, stderr }
let auditStream = null;
let runtimeRecoveryMetrics = {
  completed_at: null,
  transactions: { found: 0, recovered: 0, unresolved: 0, records: [] },
  atomic_temps: null,
  backup_retention: null,
  worktrees: { roots_scanned: 0, skipped_non_git: 0, stale: 0, removed: 0, protected_dirty: 0, errors: [] }
};
const performanceTelemetry = createPerformanceTelemetry({ filePath: PERFORMANCE_TELEMETRY_PATH });
const performanceFollow = createPerformanceFollow({ filePath: PERFORMANCE_FOLLOW_PATH });

const { defaultShell, killProcessTree, runShellCommand, spawnCapture, startBackground } = createCommandRuntime({
  MAX_COMMAND_OUTPUT, PRIMARY_ROOT, PROC_BUFFER, appendLimited, hasCommand, isoNow, processes
});
const execAccelerator = createExecAccelerator({ runShellCommand });
const runAcceleratedShellCommand = (command, cwd, shell, timeoutMs, options = {}) =>
  execAccelerator.run(command, cwd, shell, timeoutMs, options);

const worktreeCore = createWorktreeCore({
  WORKTREE_BASE_DIR,
  spawnCapture,
  parsePorcelain,
  DEFAULT_CMD_TIMEOUT
});

const editTransaction = createEditTransactionCore();
const transactionJournal = createTransactionJournal({ JOURNAL_PATH: TRANSACTION_JOURNAL_PATH, isoNow });
const {
  applyOne, applyOperations, applyUnifiedDiff, createBackupBatch, discardBackupBatch, dryRunUnifiedDiff,
  pruneBackupHistory, readPatchHistory, restoreBackupBatch, runJournaledMutation, writePatchHistory
} = createPatchCore({
  BACKUPS_DIR, PATCH_HISTORY_PATH, editTransaction, isoNow, resolvePath, toRel, transactionJournal
});

async function prewarmRecentContexts() {
  const snapshot = performanceTelemetry.snapshot();
  const candidates = [
    ...(snapshot.active || []).map((entry) => entry?.context_root || entry?.root),
    ...(snapshot.recent || []).slice().reverse().map((entry) => entry?.context_root || entry?.root),
    PRIMARY_ROOT
  ];
  const selected = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const requested = path.resolve(candidate);
    if (!isWithinRoots(requested)) continue;
    let resolved = requested;
    try {
      resolved = (await discoverActiveProjectRoot({
        workspaceRoot: projectRootForPath(requested),
        requestedRoot: requested
      })).root;
    } catch {
      // Fall back to the requested root when nested project discovery is unavailable.
    }
    if (!isWithinRoots(resolved)) continue;
    if (selected.some((root) => comparePath(root) === comparePath(resolved))) continue;
    selected.push(resolved);
    if (selected.length >= 3) break;
  }
  if (!selected.length) return;
  try {
    const runtime = await getNextApplicationRuntime();
    await Promise.allSettled(selected.flatMap((root) => [
      (async () => {
        const started = performance.now();
        let success = true;
        let providers = null;
        try {
          providers = await runtime.prewarmContext(root);
          success = Object.values(providers || {}).every((receipt) => receipt?.status === "fulfilled");
        } catch (error) {
          success = false;
          throw error;
        } finally {
          performanceFollow.recordPrewarm({
            root: projectRootForPath(root),
            projectRoot: root,
            name: "context",
            success,
            providers,
            durationMs: performance.now() - started
          });
        }
      })(),
      execAccelerator.warm(root)
    ]));
  } catch (error) {
    await lifecycleLog(`context prewarm failed: ${String(error?.message || error).slice(0, 500)}`);
  }
}

async function runStartupRecovery() {
  let transactions = { found: 0, recovered: 0, unresolved: 0, records: [] };
  try {
    const result = await transactionJournal.recoverIncomplete({
      restoreBackup: (backup) => restoreBackupBatch(backup, { consumeHistory: false }),
      discardBackup: discardBackupBatch
    });
    transactions = { ...result, records: (result.records || []).slice(0, 20) };
  } catch (error) {
    transactions = { ...transactions, unresolved: 1, error: String(error?.message || error).slice(0, 1000) };
  }

  let atomicTemps = null;
  try {
    atomicTemps = await cleanupOrphanAtomicTemps({ roots: [...ROOTS, DATA_DIR] });
  } catch (error) {
    atomicTemps = { error: String(error?.message || error).slice(0, 1000) };
  }

  let backupRetention = null;
  try {
    backupRetention = await pruneBackupHistory(50);
  } catch (error) {
    backupRetention = { error: String(error?.message || error).slice(0, 1000) };
  }

  const worktrees = { roots_scanned: 0, skipped_non_git: 0, stale: 0, removed: 0, protected_dirty: 0, errors: [] };
  for (const root of ROOTS) {
    try {
      const result = await worktreeCore.gc({ cwd: root, maxAgeMs: WORKTREE_GC_MAX_AGE_MS });
      worktrees.roots_scanned += 1;
      if (result.skipped_non_git) worktrees.skipped_non_git += 1;
      worktrees.stale += result.stale || 0;
      worktrees.removed += result.removed || 0;
      worktrees.protected_dirty += result.protected_dirty || 0;
      for (const error of result.errors || []) {
        if (worktrees.errors.length < 20) worktrees.errors.push({ root, ...error });
      }
    } catch (error) {
      if (worktrees.errors.length < 20) {
        worktrees.errors.push({ root, error: String(error?.message || error).slice(0, 1000) });
      }
    }
  }

  return {
    completed_at: isoNow(),
    transactions,
    atomic_temps: atomicTemps,
    backup_retention: backupRetention,
    worktrees
  };
}

const workspaceStateRegistry = createWorkspaceStateRegistry({ DATA_DIR, isoNow, comparePath });

const { detectTestCommands, parseTestFailures, runGatedCommand } = createTestCore({ runShellCommand: runAcceleratedShellCommand });

const { loadWorkspaceProfile, registerProfileTools, getTestCommandsMerged } = createWorkspaceProfile({
  PRIMARY_ROOT, detectTestCommands, jsonResult, log, reg
});

// ----------------------------------------------------------------------------
// Bootstrap
// ----------------------------------------------------------------------------
await mkdir(DATA_DIR, { recursive: true });
await mkdir(WORKSPACE_DATA_DIR, { recursive: true });
await mkdir(PRIMARY_ROOT, { recursive: true });
await mkdir(BACKUPS_DIR, { recursive: true });
await mkdir(AGENT_STATE_DIR, { recursive: true });
await Promise.all([performanceTelemetry.load(), performanceFollow.load()]);
const reclassifiedPerformanceSamples = performanceFollow.reclassifyTasks(performanceTelemetry.taskClassMap());
if (reclassifiedPerformanceSamples > 0) await performanceFollow.flush();

runtimeRecoveryMetrics = await runStartupRecovery();
void prewarmRecentContexts();

if (AUDIT_ENABLED) {
  auditStream = createWriteStream(AUDIT_PATH, { flags: "a" });
  auditStream.on("error", () => {});
}

// v2.8 Load workspace profile on startup
await loadWorkspaceProfile();

// Detect ripgrep once at startup — the fastest search engine when present.
const RG_BIN = await detectRg();
if (RG_BIN) console.log("ripgrep detected: search_text/find_files will use rg");
const ADB_BIN = detectAdbBinary();
if (ADB_BIN) console.log(`adb detected: ${ADB_BIN}`);

const {
  attachContext, buildTree, buildTreeFast, findFiles, gitGrep, listEntries, listRepoFilesFast,
  ripgrepGrep, searchTree
} = createFilesystemCore({ RG_BIN, SKIP_DIRS, toRel });


const { collectImportantFiles, compactGitStatus, detectProjectProfile, recommendNextActions, scanSymbols } = createProjectIntelligence({
  DEFAULT_CMD_TIMEOUT, SKIP_DIRS, parsePorcelain, spawnCapture, toRel
});

const {
  buildRepoIndex, indexFresh, indexMatches, readRepoIndex, relEntriesToAbs, symbolsCover, treeCovers, writeRepoIndex
} = createRepoIndexCore({
  INDEX_PATH, REPO_INDEX_TTL_MS, RG_BIN, buildTreeFast, collectImportantFiles,
  compactGitStatus, detectProjectProfile, isoNow, scanSymbols, toRel
});

const { analyzeDiff, buildSessionReport, collectWorkspaceDoctor, recommendedReads, runQualityGate } = createVerificationCore({
  ALLOWED_ORIGINS, AUTH_TOKEN, PRODUCT_TIER, RG_BIN, ROOTS, VERSION, collectImportantFiles,
  compactGitStatus, detectProjectProfile, getTestCommandsMerged, isoNow, resolvePath, runGatedCommand, toRel,
  resolveActiveProjectRoot: discoverActiveProjectRoot,
  getRuntimeRecoveryMetrics: () => runtimeRecoveryMetrics
});

function verificationCachePathForRoot(root) {
  const id = createHash("sha256").update(comparePath(root)).digest("hex").slice(0, 16);
  return path.join(DATA_DIR, "workspaces", id, "verification-cache.json");
}

const changeAwareVerification = createChangeAwareVerification({
  getTestCommandsMerged,
  runGatedCommand,
  cachePathForRoot: verificationCachePathForRoot
});

const postEditIntelligence = createPostEditIntelligence({
  getNextApplicationRuntime,
  getTestCommandsMerged,
  changeAwareVerification,
  resolveProjectRoot: async (file) => {
    const workspaceRoot = projectRootForPath(file);
    return (await discoverActiveProjectRoot({
      workspaceRoot,
      requestedRoot: path.dirname(file),
      changedFiles: [file]
    })).root;
  },
  runShellCommand
});

function detectRg() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("rg", ["--version"], { windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? "rg" : null));
  });
}

function detectAdbBinary() {
  const executable = process.platform === "win32" ? "adb.exe" : "adb";
  const candidates = [
    process.env.ADB,
    process.env.ANDROID_ADB,
    process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, "platform-tools", executable) : null,
    process.env.ANDROID_SDK_ROOT ? path.join(process.env.ANDROID_SDK_ROOT, "platform-tools", executable) : null,
    path.join(os.homedir(), "Android", "Sdk", "platform-tools", executable),
    path.join(os.homedir(), "Android", "sdk", "platform-tools", executable)
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return hasCommand("adb") ? "adb" : null;
}

const compactMcpInterface = await import("./dist/interfaces/mcp/compact-mcp-interface.js").catch((error) => {
  throw new Error(`Compiled compact MCP interface is unavailable. Run npm run build:next. ${error?.message || error}`);
});

const INTERNAL_MCP_SERVERS = new WeakSet();
let legacyBackendRuntimePromise = null;

function createMcpServer() {
  const mcp = new McpServer(
    { name: "Local Coding Agent", version: VERSION },
    { instructions: compactMcpInterface.COMPACT_SERVER_INSTRUCTIONS }
  );
  registerCompanionAppResources(mcp);
  registerCompactTools(mcp);
  registerNotionPageTool(mcp);
  return mcp;
}

function registerBackendTools(mcp) {
  registerBasicTools(mcp);
  registerSharedWorkspaceTools(mcp);
  registerFigmaDesktopTools(mcp);
  registerDBeaverDesktopTools(mcp);
  registerBrunoDesktopTools(mcp);
  registerPenpotMcpTools(mcp);
  registerCoolifyMcpTools(mcp);
  registerNotionTools(mcp, {
    registerTool: reg,
    jsonResult,
    apiOptions: notionApiOptions(),
    apiVersion: NOTION_VERSION
  });
  registerFsReadTools(mcp);
  registerFsWriteTools(mcp);
  registerExecTools(mcp);
  registerProcessTools(mcp);
  registerGitTool(mcp);
  registerSkillTools(mcp);
  registerRepoIntelTools(mcp);    // v2.1
  registerCodeIntelligenceTools(mcp); // v4.5 — LSP/compiler-native navigation + refactor
  registerCompanionTools(mcp);    // v2.9 — @ context + / workflow UI helpers
  registerPatchEngineTools(mcp);  // v2.2
  registerTestRunnerTools(mcp);   // v2.3
  registerReviewTools(mcp);       // v2.4
  registerAgentTools(mcp);        // v4.5 — delegated model agents
  registerUiTools(mcp);           // v4.5 — browser + Android automation
  registerPlannerTools(mcp);      // v2.5
  registerProfileTools(mcp);      // v2.8
}

function registerCompactTools(mcp) {
  compactMcpInterface.registerCompactMcpTools(mcp, {
    registerTool: reg,
    callBackendTool: (name, args, project) =>
      project
        ? CONVERSATION_RUNTIME.run({
          primaryRoot: project,
          correlationId: ACTION_PIPELINE.currentCorrelationId() || randomUUID()
        }, () => callLegacyTool(name, args))
        : callLegacyTool(name, args),
    listBackendTools: async () => (await getLegacyBackendRuntime()).tools,
    registerLcaInputTool,
    structuredJsonResult
  });
}

async function getLegacyBackendRuntime() {
  if (!legacyBackendRuntimePromise) {
    legacyBackendRuntimePromise = createLegacyBackendRuntime().catch((error) => {
      legacyBackendRuntimePromise = null;
      throw error;
    });
  }
  return legacyBackendRuntimePromise;
}

async function createLegacyBackendRuntime() {
  const backend = new McpServer({ name: "Local Coding Agent Backend", version: VERSION }, { instructions: "Internal compatibility backend." });
  INTERNAL_MCP_SERVERS.add(backend);
  registerBackendTools(backend);
  const client = new Client({ name: "lca-compact-facade", version: VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await backend.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  return { backend, client, tools: listed.tools || [] };
}

async function closeLegacyBackendRuntime() {
  if (!legacyBackendRuntimePromise) return;
  try {
    const runtime = await legacyBackendRuntimePromise;
    try { await runtime.client.close(); } catch {}
    try { await runtime.backend.close(); } catch {}
  } finally {
    legacyBackendRuntimePromise = null;
  }
}

async function callLegacyTool(name, args = {}) {
  const runtime = await getLegacyBackendRuntime();
  return runtime.client.callTool({ name, arguments: args });
}

const { defaultSkillsDir, discoverSkills, isWithinSkillsDir, readNotes, sanitizeSkillName, writeNotes } = createNotesSkills({
  NOTES_PATH, PRIMARY_ROOT, ROOTS, SKILLS_DIRS
});

const registerSkillTools = createSkillToolRegistrar({
  reg, jsonResult, defaultSkillsDir, discoverSkills, isWithinSkillsDir, resolvePath, sanitizeSkillName, MAX_READ_CHARS, PRIMARY_ROOT
});

const COMPANION_QUICK_ACTIONS = new Set(["plan"]);

const WORKFLOW_COMMANDS = [
  {
    name: "plan",
    type: "mode",
    command: "/plan",
    label: "Plan mode",
    description: "Inspect context and propose a plan first. Do not edit files until the user approves.",
    prompt: "Use plan mode. Do not edit files yet. Inspect the selected context, identify risks, then return a concrete plan and verification steps."
  },
  {
    name: "implement",
    type: "workflow",
    command: "/implement",
    label: "Implement",
    description: "Apply the requested change with focused edits, then summarize what changed.",
    prompt: "Implement the requested change using LCA tools. Keep edits focused, preserve existing behavior, and summarize the modified files."
  },
  {
    name: "debug",
    type: "workflow",
    command: "/debug",
    label: "Debug",
    description: "Reproduce/inspect a problem, find the likely cause, then propose or apply a fix.",
    prompt: "Use debug workflow. Gather evidence first, isolate the likely cause, then propose a fix. Avoid guessing when a targeted read/search can verify it."
  },
  {
    name: "review",
    type: "workflow",
    command: "/review",
    label: "Review",
    description: "Review code or a diff for bugs, risks, and missing verification.",
    prompt: "Use review workflow. Focus on correctness, security, edge cases, and test coverage. Return prioritized findings and concrete fixes."
  },
  {
    name: "refactor",
    type: "workflow",
    command: "/refactor",
    label: "Refactor",
    description: "Improve structure without changing intended behavior.",
    prompt: "Use refactor workflow. Preserve behavior, keep changes incremental, and call out any risk before editing."
  },
  {
    name: "release",
    type: "workflow",
    command: "/release",
    label: "Release",
    description: "Prepare/check a release: changelog, tests, versioning, packaging, and rollout notes.",
    prompt: "Use release workflow. Check repo state, versioning, release notes, and verification steps before suggesting a release."
  },
  {
    name: "setup",
    type: "workflow",
    command: "/setup",
    label: "Setup",
    description: "Diagnose or improve local setup/onboarding flows.",
    prompt: "Use setup workflow. Review install/setup docs, scripts, platform-specific paths, and first-run failure modes."
  },
  {
    name: "context",
    type: "workflow",
    command: "/context",
    label: "Context pack",
    description: "Gather a compact workspace context pack before deciding what to do.",
    prompt: "Call workspace_context with the concrete task first so filesystem, native semantic analysis, CodeGraph, and AgentMemory are all searched, then ask only for genuinely missing information."
  }
];

const { workspaceSearchData, slashCommandData, composeLcaPrompt, projectRootLabels } = createCompanionContextSearch({
  ROOTS, PRIMARY_ROOT, WORKFLOW_COMMANDS, comparePath, isWithinRoots, discoverSkills,
  listRepoFilesFast, scanSymbols, resolvePath, toRel
});


const { registerCompanionAppResources, registerCompanionTools, registerLcaInputTool } = createCompanionMcp({
  COMPANION_QUICK_ACTIONS, COMPANION_WIDGET_RESOURCE, COMPANION_WIDGET_URI,
  DBEAVER_SQL_ARTIFACT_LEGACY_URI, DBEAVER_SQL_ARTIFACT_RESOURCE, DBEAVER_SQL_ARTIFACT_URI,
  PRIMARY_ROOT, ROOTS, WORKFLOW_COMMANDS, composeLcaPrompt, reg, resolvePath, slashCommandData,
  structuredJsonResult, workspaceSearchData
});

const scheduleAgentMemoryObservation = createAgentMemoryObservation({
  getNextApplicationRuntime, isWithinRoots, log, PRIMARY_ROOT, resolvePath, ROOTS
});

// ----------------------------------------------------------------------------
// Tool registration helper: audit + uniform error handling
// ----------------------------------------------------------------------------
function inferTelemetryRoot(args, result) {
  for (const candidate of telemetryPathCandidates(args, result)) {
    try { return projectRootForPath(resolvePath(candidate)); } catch { /* ignore non-path args */ }
  }
  return PRIMARY_ROOT;
}

function telemetryAction(args) {
  return typeof args?.action === "string" && args.action.trim() ? args.action.trim() : null;
}

function reg(mcp, name, def, handler) {
  const modelFacing = !INTERNAL_MCP_SERVERS.has(mcp);
  mcp.registerTool(name, def, async (args, extra) => {
    const startedAt = isoNow();
    const startedMs = performance.now();
    const argSummary = AUDIT_ENABLED && AUDIT_ARGS ? summarizeArgs(args) : "";
    let inChars = 0;
    try { inChars = JSON.stringify(args ?? {}).length; } catch { inChars = argSummary.length; }
    let result;
    try {
      result = await ACTION_PIPELINE.execute({
        name,
        surface: modelFacing ? "facade" : "backend",
        args: args ?? {},
        resultIsError: (value) => Boolean(value?.isError)
      }, () => handler(args ?? {}, extra));
    } catch (err) {
      result = { content: [{ type: "text", text: `ERROR: ${err?.message || err}` }], isError: true };
    }
    const success = !result?.isError;
    const outChars = resultLen(result);
    const modelOutBytes = modelVisibleResultBytes(result);
    const durationMs = Math.max(0, Math.round((performance.now() - startedMs) * 10) / 10);
    const errText = success ? null : firstText(result).slice(0, 200);
    audit({ ts: startedAt, tool: name, ok: success, durationMs, inChars, outChars, error: errText || undefined, args: argSummary || undefined });
    const action = telemetryAction(args ?? {});
    const isPerformanceProbe = name === "workspace_status" && (action === "performance" || action === "performance_follow");
    if (modelFacing && !isPerformanceProbe) {
      try {
        const telemetryRoot = inferTelemetryRoot(args ?? {}, result);
        const trace = performanceTelemetry.recordToolCall({
          tool: name,
          action,
          root: telemetryRoot,
          task: name === "workspace_context" ? args?.task : null,
          success,
          durationMs,
          inChars,
          outChars: modelOutBytes,
          result
        });
        performanceFollow.recordToolCall({
          tool: name,
          action,
          root: telemetryRoot,
          trace,
          success,
          durationMs,
          inChars,
          outBytes: modelOutBytes,
          result
        });
      } catch { /* performance recording must never downgrade a tool result */ }
    }
    if (modelFacing && RECORD_AGENTMEMORY_SESSIONS) {
      scheduleAgentMemoryObservation(name, args ?? {}, result, success, durationMs, outChars, errText);
    }
    return result;
  });
}

// ----------------------------------------------------------------------------
// Basic tools
// ----------------------------------------------------------------------------
function workspaceInfoPayload() {
  return {
    status: "ok",
    version: VERSION,
    tier: PRODUCT_TIER,
    runtime: "trusted-local",
    tool_surface: TOOL_SURFACE,
    agentmemory_session_recording: RECORD_AGENTMEMORY_SESSIONS,
    auth: AUTH_TOKEN ? "bearer" : "none",
    roots: ROOTS,
    primary_root: PRIMARY_ROOT,
    conversation_primary_root: CONVERSATION_RUNTIME.scopedPrimaryRoot() || null,
    effective_primary_root: activePrimaryRoot(),
    discovery_roots: activeDiscoveryRoots(),
    host: { platform: os.platform(), release: os.release(), hostname: os.hostname(), cwd: process.cwd(), node: process.version },
    limits: {
      max_read_chars: MAX_READ_CHARS,
      max_batch_read_chars: MAX_BATCH_READ_CHARS,
      max_command_output: MAX_COMMAND_OUTPUT,
      max_parallel_tasks: MAX_PARALLEL_TASKS,
      max_task_steps: MAX_TASK_STEPS,
      max_parallel_steps: MAX_PARALLEL_STEPS,
      max_task_concurrency: MAX_TASK_CONCURRENCY,
      max_procs: MAX_PROCS
    },
    running_processes: [...processes.values()].filter((p) => p.status === "running").length,
    runtime_recovery: runtimeRecoveryMetrics,
    performance: performanceTelemetry.snapshot(),
    performance_follow: performanceFollow.report({ windowDays: 30, taskClass: "user", compact: true }),
    exec_accelerator: execAccelerator.stats(),
    execution_model: [
      "Trusted local engine: tool actions execute directly without policy or approval round-trips.",
      "Configured project roots are discovery and relative-path defaults, not authorization boundaries.",
      "Commands are not executed inside an OS sandbox; connect only trusted projects and users.",
      "Transport integrity remains enforced through loopback binding, optional bearer auth, origin checks, timeouts, output caps, and process-tree cleanup."
    ]
  };
}

const registerBasicTools = createBasicToolRegistrar({
  reg, jsonResult, textResult, isoNow, readNotes, writeNotes, workspaceInfoPayload, performanceFollow,
  workspaceStateRegistry, resolvePath, projectRootForPath, PRIMARY_ROOT
});

const registerFsReadTools = createFsReadToolRegistrar({
  reg, jsonResult, resolvePath, toRel, listEntries, ripgrepGrep, gitGrep, attachContext, findFiles, searchTree, buildTree,
  RG_BIN, MANIFEST_NAMES, MAX_BATCH_READ_CHARS, MAX_READ_CHARS, READ_DEFAULT
});

const registerFsWriteTools = createFsWriteToolRegistrar({
  reg, jsonResult, resolvePath, toRel, applyOperations, applyUnifiedDiff, createBackupBatch, runJournaledMutation, editTransaction,
  postEditIntelligence, workspaceStateRegistry, projectRootForPath, changeAwareVerification,
  resolveActiveProjectRoot: discoverActiveProjectRoot
});

const registerExecTools = createExecToolRegistrar({
  reg, jsonResult, resolvePath, defaultShell, runShellCommand: runAcceleratedShellCommand, execAccelerator, trimOutput,
  CMD_OUTPUT_DEFAULT, DEFAULT_CMD_TIMEOUT, MAX_COMMAND_OUTPUT
});

const registerProcessTools = createProcessToolRegistrar({
  reg, jsonResult, resolvePath, killProcessTree, startBackground, processes, MAX_PROCS, PROC_BUFFER
});

const registerGitTool = createGitToolRegistrar({
  reg, jsonResult, resolvePath, parsePorcelain, spawnCapture, DEFAULT_CMD_TIMEOUT, worktreeCore
});

function parsePorcelain(out) {
  const files = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const index = line[0];
    const worktree = line[1];
    let rest = line.slice(3);
    let from = null;
    let to = rest;
    const arrow = rest.indexOf(" -> ");
    if (arrow !== -1) {
      from = rest.slice(0, arrow);
      to = rest.slice(arrow + 4);
    }
    files.push({
      index: index === " " ? null : index,
      worktree: worktree === " " ? null : worktree,
      path: to,
      from,
      staged: index !== " " && index !== "?",
      untracked: index === "?" && worktree === "?"
    });
  }
  return files;
}

// ----------------------------------------------------------------------------
// Workspace path routing
// ----------------------------------------------------------------------------
// Absolute paths are accepted. Configured project-qualified paths (for example
// `twa-verimie-app/lib/main.dart`) route directly to that workspace. For an
// ordinary relative path, all configured roots are peers: an existing file, or
// the root with the deepest existing parent for a new path, wins. Ambiguous
// paths fail instead of silently mutating the default workspace.
function resolvePath(input = ".") {
  const raw = String(input ?? ".").trim() || ".";
  if (path.isAbsolute(raw)) return path.normalize(raw);

  const configured = resolveConfiguredProjectReference(raw);
  if (configured) return path.normalize(configured);

  // Bare/default tool calls keep a deterministic workspace for backwards
  // compatibility. Any explicit relative target uses peer-root routing below.
  if (raw === ".") return PRIMARY_ROOT;
  if (ROOTS.length <= 1) return path.normalize(path.resolve(PRIMARY_ROOT, raw));

  const candidates = ROOTS.map((root) => ({ root, target: path.resolve(root, raw) }));
  const existing = candidates.filter(({ target }) => existsSync(target));
  if (existing.length === 1) return path.normalize(existing[0].target);
  if (existing.length > 1) throw ambiguousWorkspacePath(raw, existing.map(({ root }) => root));

  // For creates, infer the intended project from the deepest existing parent.
  // This lets `server/core/new-file.mjs` route to the one workspace that already
  // owns `server/core`, without falling back to PRIMARY_ROOT.
  const ranked = candidates
    .map(({ root, target }) => ({ root, target, depth: existingParentDepth(root, target) }))
    .sort((left, right) => right.depth - left.depth);
  const bestDepth = ranked[0]?.depth ?? 0;
  const best = ranked.filter((entry) => entry.depth === bestDepth && bestDepth > 0);
  if (best.length === 1) return path.normalize(best[0].target);

  throw ambiguousWorkspacePath(raw, best.length ? best.map(({ root }) => root) : ROOTS);
}

function projectRootForPath(input) {
  const target = path.resolve(input);
  const candidates = ROOTS
    .filter((root) => isWithinRoots(target, [root]))
    .sort((left, right) => path.resolve(right).length - path.resolve(left).length);
  return candidates[0] || path.dirname(target);
}

function existingParentDepth(root, target) {
  const normalizedRoot = path.resolve(root);
  let current = path.dirname(target);
  while (isWithinRoots(current, [normalizedRoot])) {
    if (existsSync(current)) {
      const relative = path.relative(normalizedRoot, current);
      return relative ? relative.split(path.sep).filter(Boolean).length : 0;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return 0;
}

function ambiguousWorkspacePath(input, roots) {
  const labels = projectRootLabels();
  const choices = roots.map((root) => labels.get(comparePath(root)) || path.basename(root) || root);
  return new Error(
    `Ambiguous relative path '${input}' across configured workspaces (${choices.join(", ")}). ` +
    "Use an absolute path or prefix it with the project name."
  );
}

function resolveConfiguredProjectReference(input) {
  const segments = String(input || "")
    .split(/[\\/]+/)
    .filter(Boolean);
  if (!segments.length || segments.includes("..")) return null;

  const portable = segments.join("/");
  const labels = projectRootLabels();
  const basenameCounts = new Map();
  for (const root of ROOTS) {
    const name = path.basename(root);
    basenameCounts.set(name, (basenameCounts.get(name) || 0) + 1);
  }

  const matches = new Map();
  for (const root of ROOTS) {
    const aliases = new Set([labels.get(comparePath(root))]);
    const basename = path.basename(root);
    if (basenameCounts.get(basename) === 1) aliases.add(basename);
    for (const alias of aliases) {
      if (!alias) continue;
      if (portable !== alias && !portable.startsWith(`${alias}/`)) continue;
      const remainder = portable === alias ? "" : portable.slice(alias.length + 1);
      const resolved = path.resolve(root, remainder);
      matches.set(comparePath(resolved), resolved);
    }
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

function isWithinRoots(p, roots = ROOTS) {
  return roots.some((root) => {
    const target = comparePath(p);
    const base = comparePath(root);
    const withSep = base.endsWith(path.sep) ? base : base + path.sep;
    return target === base || target.startsWith(withSep);
  });
}

// Keep existing output formatting: paths under the default root are compact,
// while peer-workspace paths stay absolute. Input routing is handled by
// resolvePath(), so changing display paths is unnecessary and would break
// companion search consumers that already understand absolute peer paths.
function toRel(abs) {
  const primaryRoot = activePrimaryRoot();
  if (comparePath(abs) === comparePath(primaryRoot)) return ".";
  const withSep = primaryRoot.endsWith(path.sep) ? primaryRoot : primaryRoot + path.sep;
  if (comparePath(abs).startsWith(comparePath(withSep))) return abs.slice(withSep.length).split(path.sep).join("/");
  return abs;
}

// ----------------------------------------------------------------------------
// Listing / search
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
// Notes
// ----------------------------------------------------------------------------
function log(message) {
  console.log(`${isoNow()} ${message}`);
}

async function lifecycleLog(message) {
  const line = `${isoNow()} pid=${process.pid} ${message}\n`;
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(LIFECYCLE_LOG_PATH, line, "utf8");
  } catch {
    // Lifecycle logging must never block process cleanup.
  }
}

function audit(entry) {
  if (!AUDIT_ENABLED) return;
  const line = `${JSON.stringify(entry)}\n`;
  if (auditStream && !auditStream.destroyed) {
    auditStream.write(line);
    return;
  }
  appendFile(AUDIT_PATH, line, "utf8").catch(() => {});
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

// Compact JSON keeps payloads (and the tokens ChatGPT must read) small, which
// is the main lever for perceived speed over the tunnel.
function jsonResult(value) {
  return textResult(JSON.stringify(value));
}

function structuredJsonResult(value) {
  return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
}

function localBrowserOrigins() {
  return new Set([
    `http://${HOST}:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    `http://[::1]:${PORT}`
  ]);
}

const registerRepoIntelTools = createRepoIntelToolRegistrar({
  reg, jsonResult, resolvePath, toRel, buildRepoIndex, collectImportantFiles,
  collectWorkspaceDoctor, detectProjectProfile, getNextApplicationRuntime, indexFresh,
  isoNow, readRepoIndex, recommendNextActions, recommendedReads, relEntriesToAbs,
  resolveTaskProjectRoot, resolveActiveProjectRoot: discoverActiveProjectRoot, scanSymbols, writeRepoIndex, workspaceStateRegistry, projectRootForPath,
  changeAwareVerification, getPerformanceSnapshot: () => performanceTelemetry.snapshot(),
  ALLOWED_ORIGINS, AUTH_TOKEN, MANIFEST_NAMES, PRIMARY_ROOT, PRODUCT_TIER,
  REPO_INDEX_TTL_MS, RG_BIN, ROOTS, VERSION
});

const registerPatchEngineTools = createPatchEngineToolRegistrar({
  reg, jsonResult, dryRunUnifiedDiff, readPatchHistory, resolvePath, restoreBackupBatch, writePatchHistory
});

// ============================================================================
// v2.3 — Smart Test / Build Runner
// ============================================================================

const registerTestRunnerTools = createTestRunnerToolRegistrar({
  reg, jsonResult, detectProjectProfile, getTestCommandsMerged, resolvePath,
  runGatedCommand, runQualityGate, spawnCapture, DEFAULT_CMD_TIMEOUT,
  workspaceStateRegistry, projectRootForPath,
  changeAwareVerification, resolveActiveProjectRoot: discoverActiveProjectRoot
});

function shellQuoteForCommand(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

// ============================================================================
// v2.4 — Review Mode
// ============================================================================

const registerReviewTools = createReviewToolRegistrar({
  reg, jsonResult, analyzeDiff, buildSessionReport, buildTree, resolvePath,
  ripgrepGrep, searchTree, spawnCapture, toRel, DEFAULT_CMD_TIMEOUT, RG_BIN
});

// ============================================================================
// v2.5 — Planner / Thread Memory
// ============================================================================

const registerPlannerTools = createPlannerToolRegistrar({
  reg, jsonResult, textResult, isoNow,
  workspaceStateRegistry, resolvePath, projectRootForPath, PRIMARY_ROOT
});

// ============================================================================
// v2.8 — Workspace Profile
// ============================================================================

// Helper for explicit manual verification tools: get test commands merging profile overrides.

async function cleanupRuntime() {
  for (const proc of processes.values()) killProcessTree(proc);
  try { auditStream?.end(); } catch {}
  await Promise.all([performanceTelemetry.close(), performanceFollow.close()]);
  await closeNextApplicationRuntime();
  await closeLegacyBackendRuntime();
  await Promise.all([
    closeFigmaDesktopClients(), closeFigmaRemoteClients(), closeDBeaverDesktopClients(),
    closeBrunoDesktopClients(), closeCoolifyMcpClients()
  ]);
}

const { startHttpServer } = createHttpRuntime({
  ALLOWED_ORIGINS, AUTH_TOKEN, COMPANION_WIDGET_RESOURCE, COMPANION_WIDGET_URI, CONFIG_ID,
  DBEAVER_SQL_ARTIFACT_LEGACY_URI, DBEAVER_SQL_ARTIFACT_RESOURCE, DBEAVER_SQL_ARTIFACT_URI,
  FIGMA_REMOTE_ENABLED, HOST, HTTP_LOG, MAX_BODY_BYTES, PORT, PRIMARY_ROOT, PRODUCT_TIER,
  RECORD_AGENTMEMORY_SESSIONS, ROOTS, TOOL_SURFACE, VERSION, cleanupRuntime, createMcpServer,
  figmaRemoteBridgeOptions, finishFigmaRemoteAuthorization, lifecycleLog, log
});

startHttpServer();
