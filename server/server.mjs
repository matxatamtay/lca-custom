// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import net from "node:net";
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
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ConversationRuntimeContext } from "./dist/orchestration/conversation-runtime-context.js";
import { ActionExecutionPipeline } from "./dist/runtime/action-execution-pipeline.js";
import { RuntimeEventStore } from "./dist/runtime/runtime-event-store.js";
import { RuntimeOtelExporter } from "./dist/runtime/runtime-otel-exporter.js";
import { RuntimePluginHost } from "./dist/runtime/runtime-plugin.js";
import { summarizeArgs } from "./core/redaction.mjs";
import {
  WorkspaceProtocol,
  buildResultDigest,
  defaultMemoryVault,
  validateTaskDag
} from "./core/workspace-protocol.mjs";
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
import {
  DEFAULT_NOTION_API_BASE,
  DEFAULT_NOTION_VERSION,
  notionFetchPage,
  notionSearch,
  notionStatus
} from "./notion-api.mjs";
import { buildNotionEditProposal } from "./notion-edit-proposal.mjs";
import { registerNotionTools } from "./notion-tools.mjs";
import { AgentRunnerRegistry } from "./agent-runner.mjs";
import {
  browserAgentStatus,
  callBrowserAgentTool,
  closeBrowserAgentClient,
  listBrowserAgentTools
} from "./browser-agent-client.mjs";
import {
  isTypeScriptFamilyFile,
  tsDefinition,
  tsDiagnostics,
  tsOrganizeImports,
  tsReferences,
  tsRenameSymbol
} from "./typescript-code-intelligence.mjs";
import { ToolMetrics, measureJsonChars } from "./tool-metrics.mjs";
import { runCodeMode } from "./code-mode-runtime.mjs";
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
  reg, jsonResult, COOLIFY_BASE_URL, COOLIFY_MCP_TIMEOUT_MS, COOLIFY_ACCESS_TOKEN
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
const TASK_ID_SCHEMA = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional();
const TOUCHES_SCHEMA = z.array(z.string().min(1).max(1000)).max(200).optional();
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
const MAX_PARALLEL_TASKS = 8;
const MAX_TASK_STEPS = 8;
const MAX_PARALLEL_STEPS = 32;
const MAX_TASK_CONCURRENCY = 4;
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

function notionApiOptions() {
  return {
    token: NOTION_API_KEY,
    apiBase: NOTION_API_BASE,
    version: NOTION_VERSION,
    timeoutMs: NOTION_TIMEOUT_MS
  };
}

function registerNotionPageTool(mcp) {
  reg(
    mcp,
    "notion_page",
    {
      title: "Notion page",
      description: "Open the LCA Notion page app inside ChatGPT. It can also stage a read-only edit proposal for preview. Proposal inputs NEVER mutate Notion; only the widget's explicit Apply action may write later.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      inputSchema: {
        page_id: z.string().min(1).optional(),
        page_url: z.string().min(1).optional(),
        query: z.string().optional(),
        proposal_scope: z.enum(["whole_page", "selected_blocks", "selected_text"]).optional().describe("Stage a proposal for the whole page or a selected target. This is preview-only."),
        proposal_prompt: z.string().optional().describe("The user's rewrite instruction, retained only as proposal context."),
        proposal_source: z.string().optional().describe("Exact current Enhanced Markdown source for selected-content proposals. Must match exactly once."),
        proposal_replacement: z.string().optional().describe("Replacement Enhanced Markdown for proposal_source. Preview-only; do not call mutation tools."),
        proposal_markdown: z.string().optional().describe("Complete proposed Enhanced Markdown for whole-page preview. Preview-only; do not mutate Notion.")
      },
      _meta: {
        ui: { resourceUri: NOTION_PAGE_WIDGET_URI, visibility: ["model", "app"] },
        "openai/outputTemplate": NOTION_PAGE_WIDGET_URI,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Opening Notion…",
        "openai/toolInvocation/invoked": "Notion page ready."
      }
    },
    async ({
      page_id,
      page_url,
      query = "",
      proposal_scope,
      proposal_prompt,
      proposal_source,
      proposal_replacement,
      proposal_markdown
    }) => {
      let page = null;
      let search = null;
      let status = null;
      let proposal = null;
      if (page_id || page_url) {
        const [openedPage, recentPages] = await Promise.all([
          notionFetchPage(page_id || page_url, {
            ...notionApiOptions(),
            includeRenderData: false
          }),
          notionSearch({ query: "", page_size: 30 }, notionApiOptions()).catch(() => null)
        ]);
        page = openedPage;
        if (recentPages) search = compactNotionWidgetSearch(recentPages);
        if (proposal_scope || proposal_markdown !== undefined || proposal_replacement !== undefined) {
          proposal = buildNotionEditProposal(page, {
            proposal_scope,
            proposal_prompt,
            proposal_source,
            proposal_replacement,
            proposal_markdown
          });
        }
      } else if (query) {
        search = compactNotionWidgetSearch(await notionSearch({ query, page_size: 30 }, notionApiOptions()));
      } else {
        status = await notionStatus(notionApiOptions());
        if (status.connected) {
          search = compactNotionWidgetSearch(await notionSearch({ query: "", page_size: 30 }, notionApiOptions()));
        }
      }
      const payload = { page: compactNotionWidgetPage(page), search, status, proposal, api_version: NOTION_VERSION };
      return {
        structuredContent: payload,
        content: [{
          type: "text",
          text: proposal
            ? `Prepared a staged Notion edit preview for “${page.title}”. Nothing has been written. Review the diff and use Apply in the widget to commit it.`
            : page
            ? `Opened Notion page “${page.title}”.`
            : search
              ? `Notion page app is ready with ${search.results.length} recently edited shared pages.`
              : "Notion page app is ready."
        }],
        _meta: { ui: { resourceUri: NOTION_PAGE_WIDGET_URI }, "openai/outputTemplate": NOTION_PAGE_WIDGET_URI }
      };
    }
  );
}

function compactNotionWidgetPage(page) {
  if (!page) return null;
  const { render_data: _renderData, ...compactPage } = page;
  return compactPage;
}

function compactNotionWidgetSearch(search = {}) {
  return {
    query: String(search.query || ""),
    results: (search.results || []).map((page) => ({
      id: page.id,
      title: page.title,
      url: page.url,
      icon: page.icon,
      last_edited_time: page.last_edited_time,
      in_trash: Boolean(page.in_trash)
    })),
    has_more: Boolean(search.has_more),
    next_cursor: search.next_cursor || null
  };
}

function registerSharedWorkspaceTools(mcp) {
  const taskId = TASK_ID_SCHEMA;
  const pathList = TOUCHES_SCHEMA;

  reg(
    mcp,
    "memory_status",
    {
      title: "Persistent memory status",
      description: "Return the Obsidian-compatible persistent memory vault path and folder layout.",
      inputSchema: {}
    },
    async () => jsonResult(WORKSPACE_PROTOCOL.memoryStatus())
  );

  reg(
    mcp,
    "context_pin",
    {
      title: "Pin persistent context",
      description: "Write or update a permanent Markdown memory with provenance in the Obsidian-compatible vault.",
      inputSchema: {
        key: z.string().min(1).max(300),
        value: z.string().min(1).max(100_000),
        scope: z.enum(["global", "project"]).optional(),
        source: z.enum(["user", "repo", "assistant", "system", "tool"]).optional(),
        tags: z.array(z.string().min(1).max(100)).max(50).optional(),
        links: z.array(z.string().min(1).max(300)).max(50).optional(),
        replace: z.boolean().optional()
      }
    },
    async (args) => {
      const result = await WORKSPACE_PROTOCOL.pinContext(args);
      return jsonResult({
        ...result,
        result_digest: buildResultDigest({ ok: true, summary: `Pinned persistent context ${result.key}.`, changedFiles: [result.path] })
      });
    }
  );

  reg(
    mcp,
    "context_list",
    {
      title: "List persistent context",
      description: "List or search global/project memories stored as Markdown in the persistent vault.",
      inputSchema: {
        scope: z.enum(["all", "global", "project"]).optional(),
        query: z.string().max(1000).optional(),
        limit: z.number().int().min(1).max(200).optional()
      }
    },
    async (args) => jsonResult(await WORKSPACE_PROTOCOL.listContext(args))
  );

  reg(
    mcp,
    "context_explain",
    {
      title: "Explain persistent context",
      description: "Read one memory with its value, source, timestamps, tags, links, and vault path.",
      inputSchema: {
        key: z.string().min(1).max(300),
        scope: z.enum(["global", "project"]).optional()
      }
    },
    async (args) => jsonResult(await WORKSPACE_PROTOCOL.explainContext(args))
  );

  reg(
    mcp,
    "context_remove",
    {
      title: "Remove persistent context",
      description: "Delete one named memory from the persistent vault.",
      inputSchema: {
        key: z.string().min(1).max(300),
        scope: z.enum(["global", "project"]).optional()
      }
    },
    async (args) => {
      const result = await WORKSPACE_PROTOCOL.removeContext(args);
      return jsonResult({
        ...result,
        result_digest: buildResultDigest({ ok: true, summary: `Removed persistent context ${result.key}.`, changedFiles: [result.removed] })
      });
    }
  );

  reg(
    mcp,
    "task_brief",
    {
      title: "Create structured task brief",
      description: "Create or replace a task contract with goal, scope, exclusions, constraints, definition of done, policies, and optional path guard. Returns a task_id used by later tools.",
      inputSchema: {
        task_id: taskId,
        goal: z.string().min(1).max(5000),
        scope: z.array(z.string().min(1).max(1000)).max(200).optional(),
        out_of_scope: z.array(z.string().min(1).max(1000)).max(200).optional(),
        constraints: z.array(z.string().min(1).max(2000)).max(200).optional(),
        definition_of_done: z.array(z.string().min(1).max(2000)).max(200).optional(),
        test_policy: z.enum(["none", "changed_tests", "targeted", "full_gate"]).optional(),
        commit_policy: z.enum(["do_not_commit", "commit_when_green", "commit_and_push", "ask_before_commit"]).optional(),
        confirmation: z.enum(["never", "risky_only", "always"]).optional(),
        status: z.string().min(1).max(100).optional(),
        scope_guard: z.object({ allowed_paths: pathList, denied_paths: pathList }).optional(),
        replace: z.boolean().optional()
      }
    },
    async (args) => {
      const task = await WORKSPACE_PROTOCOL.createTaskBrief(args);
      return jsonResult({
        ok: true,
        ...task,
        vault_note: path.join(WORKSPACE_PROTOCOL.memoryStatus().folders.tasks, `${task.task_id}.md`),
        result_digest: buildResultDigest({ ok: true, taskId: task.task_id, summary: `Task brief ${task.task_id} status is ${task.status}.` })
      });
    }
  );

  reg(
    mcp,
    "task_brief_get",
    {
      title: "Read task brief",
      description: "Read a structured task brief by task_id, or the current active brief when omitted.",
      inputSchema: { task_id: taskId }
    },
    async ({ task_id }) => jsonResult(await WORKSPACE_PROTOCOL.getTask(task_id))
  );

  reg(
    mcp,
    "intent_check",
    {
      title: "Intent checksum",
      description: "Return a compact interpretation of the task, exclusions, assumptions, expected files, proposed actions, and whether confirmation is required.",
      inputSchema: {
        task_id: taskId,
        expected_files: pathList,
        assumptions: z.array(z.string().min(1).max(2000)).max(100).optional(),
        proposed_actions: z.array(z.string().min(1).max(2000)).max(100).optional(),
        risk: z.enum(["low", "medium", "high"]).optional()
      }
    },
    async (args) => jsonResult(await WORKSPACE_PROTOCOL.intentCheck(args))
  );

  reg(
    mcp,
    "scope_guard",
    {
      title: "Task scope guard",
      description: "Get, set, or clear task path allow/deny patterns. Deny rules win; write tools enforce the active guard.",
      inputSchema: {
        action: z.enum(["get", "set", "clear"]).optional(),
        task_id: taskId,
        allowed_paths: pathList,
        denied_paths: pathList
      }
    },
    async (args) => jsonResult(await WORKSPACE_PROTOCOL.scopeGuard(args))
  );

  reg(
    mcp,
    "knowledge_state",
    {
      title: "Typed task knowledge",
      description: "List, add, resolve, or remove explicitly typed facts, assumptions, decisions, and open questions with provenance.",
      inputSchema: {
        action: z.enum(["list", "add", "resolve", "remove"]).optional(),
        task_id: taskId,
        type: z.enum(["fact", "assumption", "decision", "open_question"]).optional(),
        text: z.string().max(10_000).optional(),
        source: z.enum(["user", "repo", "assistant", "system", "tool"]).optional(),
        why: z.string().max(10_000).optional(),
        id: z.string().min(1).max(200).optional()
      }
    },
    async (args) => jsonResult(await WORKSPACE_PROTOCOL.knowledgeState(args))
  );

  reg(
    mcp,
    "handoff_packet",
    {
      title: "Build structured handoff packet",
      description: "Build a structured continuation packet containing task contract, knowledge, scope, progress, tests, files, git state, and persistent-memory location without saving a checkpoint.",
      inputSchema: {
        task_id: taskId,
        summary: z.string().max(20_000).optional(),
        completed: z.array(z.string().min(1).max(2000)).max(200).optional(),
        in_progress: z.array(z.string().min(1).max(2000)).max(200).optional(),
        next_actions: z.array(z.string().min(1).max(2000)).max(200).optional(),
        files_changed: pathList,
        tests: z.array(z.object({ name: z.string().min(1).max(500), status: z.enum(["passed", "failed", "skipped", "not_run"]), detail: z.string().max(5000).optional() })).max(200).optional()
      }
    },
    async (args) => jsonResult(await buildHandoffPacket(args))
  );
}

async function buildHandoffPacket({ task_id, summary = "", completed = [], in_progress = [], next_actions = [], files_changed = [], tests = [] } = {}) {
  const base = await WORKSPACE_PROTOCOL.handoffBase(task_id);
  const statusRes = await spawnCapture("git", ["status", "--porcelain"], PRIMARY_ROOT, DEFAULT_CMD_TIMEOUT);
  const branchRes = await spawnCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"], PRIMARY_ROOT, DEFAULT_CMD_TIMEOUT);
  const gitFiles = statusRes.exit_code === 0 ? parsePorcelain(statusRes.stdout || "") : [];
  return {
    kind: "handoff_packet",
    saved_at: isoNow(),
    ...base,
    summary,
    completed,
    in_progress,
    next_actions,
    files_changed: dedupe([...files_changed, ...gitFiles.map((item) => item.path)]),
    tests,
    git: {
      is_git_repo: statusRes.exit_code === 0,
      branch: (branchRes.stdout || "").trim() || null,
      dirty: gitFiles.length > 0,
      files: gitFiles
    }
  };
}

function registerPenpotMcpTools(mcp) {
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };
  const mutation = { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false };
  const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false };
  const bridgeOptions = {
    endpoint: PENPOT_MCP_URL,
    timeoutMs: PENPOT_MCP_TIMEOUT_MS,
    userToken: PENPOT_USER_TOKEN
  };

  reg(
    mcp,
    "penpot_status",
    {
      title: "Penpot MCP status",
      description: "Check the local Penpot MCP connection and list live design tools without exposing the user token.",
      annotations: readOnly,
      inputSchema: {}
    },
    async () => jsonResult(await penpotStatus(bridgeOptions))
  );

  reg(
    mcp,
    "penpot_list_tools",
    {
      title: "List Penpot MCP tools",
      description: "List every live Penpot MCP tool with its annotations and JSON schema.",
      annotations: readOnly,
      inputSchema: {}
    },
    async () => {
      const result = await listPenpotTools(bridgeOptions);
      return jsonResult({ endpoint: PENPOT_MCP_URL, count: result.tools.length, tools: result.tools });
    }
  );

  reg(
    mcp,
    "penpot_call_tool",
    {
      title: "Call any Penpot MCP tool",
      description: "Forward any live Penpot MCP operation directly in the trusted-local runtime. Classification remains metadata only.",
      annotations: mutation,
      inputSchema: {
        tool: z.string().min(1),
        arguments: z.record(z.any()).optional()
      }
    },
    async ({ tool, arguments: upstreamArguments }) => callPenpotTool(tool, upstreamArguments || {}, bridgeOptions)
  );

  reg(
    mcp,
    "penpot_read_tool",
    {
      title: "Call Penpot tool (read compatibility alias)",
      description: "Compatibility alias that forwards the requested live Penpot MCP operation directly.",
      annotations: readOnly,
      inputSchema: {
        tool: z.string().min(1),
        arguments: z.record(z.any()).optional()
      }
    },
    async ({ tool, arguments: upstreamArguments }) => callReadOnlyPenpotTool(tool, upstreamArguments || {}, bridgeOptions)
  );

  reg(
    mcp,
    "penpot_mutate_tool",
    {
      title: "Call Penpot mutation",
      description: "Compatibility alias that forwards the requested Penpot mutation directly.",
      annotations: mutation,
      inputSchema: {
        tool: z.string().min(1),
        arguments: z.record(z.any()).optional()
      }
    },
    async ({ tool, arguments: upstreamArguments }) => callMutatingPenpotTool(tool, upstreamArguments || {}, bridgeOptions)
  );

  reg(
    mcp,
    "penpot_destructive_tool",
    {
      title: "Call a destructive Penpot operation",
      description: "Forward a destructive Penpot operation directly in trusted-local mode without an LCA confirmation round-trip.",
      annotations: destructive,
      inputSchema: {
        tool: z.string().min(1),
        arguments: z.record(z.any()).optional()
      }
    },
    async ({ tool, arguments: upstreamArguments }) => callDestructivePenpotTool(
      tool,
      upstreamArguments || {},
      bridgeOptions
    )
  );

  reg(
    mcp,
    "penpot_overview",
    {
      title: "Read Penpot MCP overview",
      description: "Read the Penpot MCP high-level usage guide before using execute_code.",
      annotations: readOnly,
      inputSchema: {}
    },
    async () => callReadOnlyPenpotTool("high_level_overview", {}, bridgeOptions)
  );

  reg(
    mcp,
    "penpot_api_info",
    {
      title: "Read Penpot Plugin API information",
      description: "Look up a Penpot Plugin API type and optionally one member before generating design code.",
      annotations: readOnly,
      inputSchema: {
        type: z.string().min(1),
        member: z.string().min(1).optional()
      }
    },
    async (args) => callReadOnlyPenpotTool("penpot_api_info", args, bridgeOptions)
  );

  reg(
    mcp,
    "penpot_inspect_page",
    {
      title: "Inspect current Penpot page",
      description: "Read a bounded tree of shapes from the currently focused Penpot page.",
      annotations: readOnly,
      inputSchema: {
        max_depth: z.number().int().min(0).max(12).optional(),
        max_shapes: z.number().int().min(1).max(5000).optional()
      }
    },
    async ({ max_depth, max_shapes }) => inspectPenpotPage({ ...bridgeOptions, maxDepth: max_depth, maxShapes: max_shapes })
  );

  reg(
    mcp,
    "penpot_inspect_selection",
    {
      title: "Inspect current Penpot selection",
      description: "Read a bounded tree rooted at the currently selected Penpot shapes.",
      annotations: readOnly,
      inputSchema: {
        max_depth: z.number().int().min(0).max(12).optional(),
        max_shapes: z.number().int().min(1).max(5000).optional()
      }
    },
    async ({ max_depth, max_shapes }) => inspectPenpotSelection({ ...bridgeOptions, maxDepth: max_depth, maxShapes: max_shapes })
  );

  reg(
    mcp,
    "penpot_export_shape",
    {
      title: "Export Penpot shape",
      description: "Export a shape, the first selected shape, or the current page as PNG or SVG for visual review.",
      annotations: readOnly,
      inputSchema: {
        shape_id: z.string().min(1).describe("Shape ID, selection, or page."),
        format: z.enum(["png", "svg"]).optional(),
        mode: z.enum(["shape", "fill"]).optional()
      }
    },
    async ({ shape_id, format, mode }) => callReadOnlyPenpotTool("export_shape", {
      shapeId: shape_id,
      ...(format ? { format } : {}),
      ...(mode ? { mode } : {})
    }, bridgeOptions)
  );

  reg(
    mcp,
    "penpot_execute_code",
    {
      title: "Execute Penpot code",
      description: "Execute JavaScript directly in the active Penpot plugin context.",
      annotations: mutation,
      inputSchema: { code: z.string().min(1) }
    },
    async ({ code }) => callMutatingPenpotTool("execute_code", { code }, bridgeOptions)
  );

  reg(
    mcp,
    "penpot_execute_destructive_code",
    {
      title: "Execute destructive Penpot code",
      description: "Execute delete/remove/clear-like JavaScript directly in trusted-local mode.",
      annotations: destructive,
      inputSchema: { code: z.string().min(1) }
    },
    async ({ code }) => callDestructivePenpotTool("execute_code", { code }, bridgeOptions)
  );
}

function registerCodeIntelligenceTools(mcp) {
  const positionShape = {
    file: z.string().min(1).max(4000),
    symbol: z.string().min(1).max(500).optional(),
    line: z.number().int().min(1).optional(),
    column: z.number().int().min(1).optional(),
    timeout_ms: z.number().int().min(1000).max(120_000).optional()
  };

  reg(mcp, "code_definition", {
    title: "Find code definition",
    description: "Find a symbol definition with native TypeScript LSP for TS/JS. Other languages use a bounded declaration-ranked text fallback.",
    inputSchema: positionShape
  }, async (input) => {
    const root = activePrimaryRoot();
    const file = resolvePath(input.file);
    if (isTypeScriptFamilyFile(file)) return jsonResult(await tsDefinition({ root, ...input, file, timeoutMs: input.timeout_ms }));
    if (!input.symbol) throw new Error("Non-TypeScript definition fallback requires symbol.");
    return jsonResult(await fallbackCodeSymbolSearch(root, input.symbol, "definition"));
  });

  reg(mcp, "code_references", {
    title: "Find code references",
    description: "Find symbol references with native TypeScript LSP for TS/JS. Other languages use a bounded exact-symbol text fallback.",
    inputSchema: { ...positionShape, include_declaration: z.boolean().optional(), limit: z.number().int().min(1).max(2000).optional() }
  }, async (input) => {
    const root = activePrimaryRoot();
    const file = resolvePath(input.file);
    if (isTypeScriptFamilyFile(file)) {
      const result = await tsReferences({ root, ...input, file, includeDeclaration: input.include_declaration, timeoutMs: input.timeout_ms });
      if (input.limit && result.references.length > input.limit) {
        return jsonResult({ ...result, count: result.references.length, references: result.references.slice(0, input.limit), truncated: true });
      }
      return jsonResult(result);
    }
    if (!input.symbol) throw new Error("Non-TypeScript reference fallback requires symbol.");
    return jsonResult(await fallbackCodeSymbolSearch(root, input.symbol, "references", input.limit ?? 500));
  });

  reg(mcp, "code_diagnostics", {
    title: "Read compiler diagnostics",
    description: "Return structured native TypeScript compiler diagnostics for one TS/JS file or the active TypeScript project.",
    inputSchema: { file: z.string().max(4000).optional(), limit: z.number().int().min(1).max(2000).optional() }
  }, async ({ file, limit }) => {
    const root = activePrimaryRoot();
    const resolved = file ? resolvePath(file) : null;
    if (resolved && !isTypeScriptFamilyFile(resolved)) {
      return jsonResult({ supported: false, engine: "quality-gate-fallback", file: resolved, recommendation: "Use workspace_verify lint/tests/build for this language." });
    }
    return jsonResult(await tsDiagnostics({ root, ...(resolved ? { file: resolved } : {}), limit }));
  });

  reg(mcp, "code_rename_symbol", {
    title: "Rename code symbol",
    description: "Preview or apply a TypeScript/JavaScript LSP symbol rename. Preview is the default; apply=true enforces the active task scope guard before writing.",
    inputSchema: { ...positionShape, new_name: z.string().min(1).max(500), apply: z.boolean().optional(), task_id: TASK_ID_SCHEMA }
  }, async (input) => {
    const root = activePrimaryRoot();
    const file = resolvePath(input.file);
    if (!isTypeScriptFamilyFile(file)) throw new Error("Safe semantic rename is currently available for TypeScript/JavaScript through TypeScript LSP.");
    const base = { root, file, symbol: input.symbol, line: input.line, column: input.column, newName: input.new_name, timeoutMs: input.timeout_ms };
    const preview = await tsRenameSymbol({ ...base, apply: false });
    const changedFiles = preview.changes.map((change) => change.file);
    const scope = await WORKSPACE_PROTOCOL.assertPathsAllowed(input.task_id, changedFiles);
    const result = input.apply === true ? await tsRenameSymbol({ ...base, apply: true }) : preview;
    return jsonResult({
      ...result,
      scope,
      result_digest: buildResultDigest({
        ok: true,
        taskId: scope.task_id,
        changedFiles,
        summary: `${input.apply === true ? "Applied" : "Previewed"} semantic rename across ${changedFiles.length} file(s).`
      })
    });
  });

  reg(mcp, "code_organize_imports", {
    title: "Organize imports",
    description: "Preview or apply TypeScript LSP source.organizeImports edits. Preview is the default and writes require the active task scope guard.",
    inputSchema: { file: z.string().min(1).max(4000), apply: z.boolean().optional(), timeout_ms: z.number().int().min(1000).max(120_000).optional(), task_id: TASK_ID_SCHEMA }
  }, async (input) => {
    const root = activePrimaryRoot();
    const file = resolvePath(input.file);
    if (!isTypeScriptFamilyFile(file)) throw new Error("Native organize-imports is currently available for TypeScript/JavaScript through TypeScript LSP.");
    const base = { root, file, timeoutMs: input.timeout_ms };
    const preview = await tsOrganizeImports({ ...base, apply: false });
    const changedFiles = preview.changes.map((change) => change.file);
    const scope = await WORKSPACE_PROTOCOL.assertPathsAllowed(input.task_id, changedFiles);
    const result = input.apply === true && preview.supported !== false ? await tsOrganizeImports({ ...base, apply: true }) : preview;
    return jsonResult({
      ...result,
      scope,
      result_digest: buildResultDigest({
        ok: true,
        taskId: scope.task_id,
        changedFiles,
        summary: `${input.apply === true ? "Applied" : "Previewed"} organize-imports for ${path.basename(file)}.`
      })
    });
  });
}

function registerAgentTools(mcp) {
  const commonTaskShape = {
    runner: z.string().optional().describe("Agent runner name. Default: codex."),
    task: z.string().min(1),
    name: z.string().min(1).max(120).optional(),
    cwd: z.string().optional().describe("Working directory. Default: conversation primary project."),
    files: z.array(z.string().min(1)).max(200).optional().describe("Optional correctness scope for delegated writes. Omit to let an isolated worker edit any file needed for the task."),
    context: z.string().max(80_000).optional().describe("Bounded parent-agent context to pass to the worker."),
    model: z.string().optional(),
    provider: z.string().min(1).max(64).optional().describe("Use one configured provider by name; explicit provider selection bypasses provider cooldown."),
    provider_chain: z.array(z.string().min(1).max(64)).max(8).optional().describe("Ordered provider fallback chain. Secrets stay server-side in environment variables."),
    reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional().describe("Default: danger-full-access."),
    isolation: z.enum(["shared", "worktree"]).optional().describe("Writable jobs default to isolated git worktrees; read-only jobs default to shared."),
    inherit_dirty: z.boolean().optional().describe("Copy current tracked/untracked state into the isolated baseline. Default true."),
    network_access: z.boolean().optional().describe("Default: true."),
    additional_directories: z.array(z.string().min(1)).max(20).optional(),
    parent_task_id: z.string().min(1).max(120).optional(),
    parent_session_id: z.string().min(1).max(200).optional(),
    task_id: TASK_ID_SCHEMA
  };

  reg(
    mcp,
    "agent_capabilities",
    {
      title: "Agent runner capabilities",
      description: "List available delegated model-agent runners and supported execution features.",
      inputSchema: {}
    },
    async () => jsonResult(getAgentRunnerRegistry().capabilities())
  );

  reg(
    mcp,
    "agent_spawn",
    {
      title: "Spawn delegated coding agent",
      description: "Start one delegated model-agent coding job. Codex is the default runner. Returns immediately with a managed job id.",
      inputSchema: commonTaskShape
    },
    async (input) => {
      const prepared = await prepareAgentTaskInput(input);
      const job = getAgentRunnerRegistry().spawn(prepared);
      return jsonResult({
        runner: prepared.runner || "codex",
        job,
        scope: prepared.scope,
        result_digest: buildResultDigest({
          ok: true,
          taskId: prepared.scope.task_id,
          changedFiles: prepared.files || [],
          summary: `Started delegated agent job ${job.id}.`
        })
      });
    }
  );

  reg(
    mcp,
    "agent_spawn_parallel",
    {
      title: "Spawn parallel delegated coding agents",
      description: "Start up to 8 independent model-agent jobs concurrently. Delegates default to danger-full-access with network enabled and isolated worktrees; only shared parallel writes require disjoint declared scopes.",
      inputSchema: {
        runner: z.string().optional(),
        cwd: z.string().optional(),
        context: z.string().max(80_000).optional(),
        model: z.string().optional(),
        provider: z.string().min(1).max(64).optional(),
        provider_chain: z.array(z.string().min(1).max(64)).max(8).optional(),
        reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
        sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
        isolation: z.enum(["shared", "worktree"]).optional(),
        inherit_dirty: z.boolean().optional(),
        network_access: z.boolean().optional(),
        additional_directories: z.array(z.string().min(1)).max(20).optional(),
        allow_overlap: z.boolean().optional(),
        task_id: TASK_ID_SCHEMA,
        tasks: z.array(z.object({
          task: z.string().min(1),
          name: z.string().min(1).max(120).optional(),
          cwd: z.string().optional(),
          files: z.array(z.string().min(1)).max(200).optional(),
          context: z.string().max(80_000).optional(),
          model: z.string().optional(),
          provider: z.string().min(1).max(64).optional(),
          provider_chain: z.array(z.string().min(1).max(64)).max(8).optional(),
          reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
          sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
          isolation: z.enum(["shared", "worktree"]).optional(),
          inherit_dirty: z.boolean().optional(),
          network_access: z.boolean().optional(),
          additional_directories: z.array(z.string().min(1)).max(20).optional()
        })).min(1).max(MAX_PARALLEL_TASKS)
      }
    },
    async (input) => {
      const workdir = resolvePath(input.cwd || ".");
      const common = { ...input, cwd: workdir };
      delete common.tasks;
      delete common.task_id;
      const preparedTasks = [];
      const allFiles = [];
      for (const task of input.tasks) {
        const taskCwd = resolveAgentPath(workdir, task.cwd || ".");
        const files = resolveAgentPaths(taskCwd, task.files || []);
        preparedTasks.push({ ...task, cwd: taskCwd, files });
        allFiles.push(...files);
      }
      const scope = await WORKSPACE_PROTOCOL.assertPathsAllowed(input.task_id, allFiles);
      const batch = getAgentRunnerRegistry().spawnParallel({ ...common, tasks: preparedTasks, allow_overlap: input.allow_overlap });
      return jsonResult({ runner: input.runner || "codex", ...batch, scope });
    }
  );

  reg(
    mcp,
    "agent_list",
    {
      title: "List delegated agent jobs",
      description: "List managed delegated model-agent jobs without returning full job output.",
      inputSchema: { runner: z.string().optional() }
    },
    async (input) => jsonResult(getAgentRunnerRegistry().list(input))
  );

  reg(
    mcp,
    "agent_collect",
    {
      title: "Collect delegated agent results",
      description: "Collect full results for a delegated agent batch or explicit job ids.",
      inputSchema: {
        runner: z.string().optional(),
        batch_id: z.string().optional(),
        job_ids: z.array(z.string().min(1)).max(MAX_PARALLEL_TASKS).optional()
      }
    },
    async (input) => jsonResult(getAgentRunnerRegistry().collect(input))
  );

  reg(
    mcp,
    "agent_stop",
    {
      title: "Stop delegated agent",
      description: "Cancel one managed delegated model-agent job.",
      inputSchema: { runner: z.string().optional(), job_id: z.string().min(1) }
    },
    async (input) => jsonResult(getAgentRunnerRegistry().stop(input))
  );

  reg(
    mcp,
    "agent_merge",
    {
      title: "Merge isolated agent result",
      description: "Apply a completed isolated agent patch only after scope validation and git apply --check. Conflicts leave the source tree unchanged.",
      inputSchema: {
        runner: z.string().optional(),
        job_id: z.string().min(1),
        target_cwd: z.string().optional(),
        cleanup: z.boolean().optional(),
        task_id: TASK_ID_SCHEMA
      }
    },
    async (input) => {
      const registry = getAgentRunnerRegistry();
      const collected = registry.collect({ runner: input.runner, job_ids: [input.job_id] });
      const job = collected.jobs?.[0];
      if (!job) throw new Error(`No delegated agent job ${input.job_id}.`);
      const scope = await WORKSPACE_PROTOCOL.assertPathsAllowed(input.task_id, job.changed_files || []);
      const result = await registry.merge({
        ...input,
        target_cwd: input.target_cwd ? resolvePath(input.target_cwd) : undefined
      });
      return jsonResult({ ...result, scope });
    }
  );

  reg(
    mcp,
    "agent_cleanup",
    {
      title: "Cleanup isolated agent worktree",
      description: "Remove a delegated agent worktree and temporary patch after review, merge, or abandonment.",
      inputSchema: { runner: z.string().optional(), job_id: z.string().min(1) }
    },
    async (input) => jsonResult(await getAgentRunnerRegistry().cleanup(input))
  );

  reg(mcp, "agent_recover", {
    title: "Recover delegated agent descriptor",
    description: "Read the durable descriptor reconstructed after LCA restart, including recoverable worktree and patch metadata.",
    inputSchema: { job_id: z.string().min(1) }
  }, async (input) => jsonResult(getAgentRunnerRegistry().recover(input)));

  reg(mcp, "agent_resume", {
    title: "Resume delegated agent",
    description: "Resume a provider-backed delegated agent when the selected runner advertises resume support; otherwise returns supported=false.",
    inputSchema: { runner: z.string().optional(), job_id: z.string().min(1) }
  }, async (input) => jsonResult(await getAgentRunnerRegistry().resume(input)));

  reg(mcp, "agent_followup", {
    title: "Follow up delegated agent",
    description: "Send a follow-up to a continuable delegated agent when supported by its runner.",
    inputSchema: { runner: z.string().optional(), job_id: z.string().min(1), content: z.string().min(1).max(80_000) }
  }, async (input) => jsonResult(await getAgentRunnerRegistry().followup(input)));

  reg(mcp, "agent_interrupt", {
    title: "Interrupt delegated agent",
    description: "Interrupt the current delegated turn when supported by its runner without deleting durable state.",
    inputSchema: { runner: z.string().optional(), job_id: z.string().min(1) }
  }, async (input) => jsonResult(await getAgentRunnerRegistry().interrupt(input)));

  reg(
    mcp,
    "agent_dag",
    {
      title: "Start agent task DAG",
      description: "Start a dependency-aware DAG of delegated coding agents. Independent ready nodes run concurrently; failed required dependencies block downstream nodes.",
      inputSchema: {
        runner: z.string().optional(),
        cwd: z.string().optional(),
        context: z.string().max(80_000).optional(),
        model: z.string().optional(),
        provider: z.string().min(1).max(64).optional(),
        provider_chain: z.array(z.string().min(1).max(64)).max(8).optional(),
        reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
        sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
        isolation: z.enum(["shared", "worktree"]).optional(),
        inherit_dirty: z.boolean().optional(),
        network_access: z.boolean().optional(),
        additional_directories: z.array(z.string().min(1)).max(20).optional(),
        max_concurrency: z.number().int().min(1).max(MAX_PARALLEL_TASKS).optional(),
        allow_overlap: z.boolean().optional(),
        task_id: TASK_ID_SCHEMA,
        tasks: z.array(z.object({
          id: z.string().min(1).max(80),
          task: z.string().min(1),
          name: z.string().min(1).max(120).optional(),
          depends_on: z.array(z.string().min(1).max(80)).max(32).optional(),
          allow_failure: z.boolean().optional(),
          cwd: z.string().optional(),
          files: z.array(z.string().min(1)).max(200).optional(),
          context: z.string().max(80_000).optional(),
          model: z.string().optional(),
          provider: z.string().min(1).max(64).optional(),
          provider_chain: z.array(z.string().min(1).max(64)).max(8).optional(),
          reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
          sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
          isolation: z.enum(["shared", "worktree"]).optional(),
          inherit_dirty: z.boolean().optional(),
          network_access: z.boolean().optional(),
          additional_directories: z.array(z.string().min(1)).max(20).optional()
        })).min(1).max(MAX_PARALLEL_STEPS)
      }
    },
    async (input) => {
      const workdir = resolvePath(input.cwd || ".");
      const allFiles = [];
      const tasks = input.tasks.map((task) => {
        const taskCwd = resolveAgentPath(workdir, task.cwd || ".");
        const files = resolveAgentPaths(taskCwd, task.files || []);
        const additionalDirectories = resolveAgentPaths(taskCwd, task.additional_directories || []);
        allFiles.push(...files);
        return { ...task, cwd: taskCwd, files, additional_directories: additionalDirectories };
      });
      const scope = await WORKSPACE_PROTOCOL.assertPathsAllowed(input.task_id, allFiles);
      const dag = getAgentRunnerRegistry().spawnDag({
        ...input,
        cwd: workdir,
        additional_directories: resolveAgentPaths(workdir, input.additional_directories || []),
        tasks
      });
      return jsonResult({ ...dag, scope });
    }
  );

  reg(
    mcp,
    "agent_dag_collect",
    {
      title: "Collect agent DAG",
      description: "Inspect DAG node states and optionally include delegated job results.",
      inputSchema: { dag_id: z.string().min(1), include_results: z.boolean().optional() }
    },
    async (input) => jsonResult(getAgentRunnerRegistry().collectDag(input))
  );

  reg(
    mcp,
    "agent_dag_stop",
    {
      title: "Stop agent DAG",
      description: "Cancel active jobs and pending nodes in one delegated agent DAG.",
      inputSchema: { dag_id: z.string().min(1) }
    },
    async (input) => jsonResult(getAgentRunnerRegistry().stopDag(input))
  );
}

function registerUiTools(mcp) {
  reg(
    mcp,
    "ui_status",
    {
      title: "UI automation status",
      description: "Check Local Browser Agent connectivity plus ADB availability and attached Android devices.",
      inputSchema: {}
    },
    async () => {
      const [browser, android] = await Promise.all([
        browserAgentStatus().catch((error) => ({ ok: false, error: error?.message || String(error) })),
        androidDevices().catch((error) => ({ ok: false, error: error?.message || String(error), devices: [] }))
      ]);
      return jsonResult({ browser, android });
    }
  );

  reg(
    mcp,
    "ui_browser_actions",
    {
      title: "List browser automation actions",
      description: "List the browser_* tools exposed by Local Browser Agent, including their live input schemas.",
      inputSchema: { refresh: z.boolean().optional() }
    },
    async ({ refresh = false }) => jsonResult({ tools: await listBrowserAgentTools({ refresh }) })
  );

  reg(
    mcp,
    "ui_browser_call",
    {
      title: "Call browser automation action",
      description: "Call one browser_* Local Browser Agent action. Trusted-local browser builds auto-authorize ordinary HTTP/HTTPS tabs without an LCA approval round-trip.",
      inputSchema: {
        tool: z.string().regex(/^browser_[a-z0-9_]+$/i),
        arguments: z.record(z.any()).optional()
      }
    },
    async ({ tool, arguments: args = {} }) => await callBrowserAgentTool(tool, args)
  );

  reg(
    mcp,
    "ui_android_devices",
    {
      title: "List Android devices",
      description: "List ADB devices/emulators and their connection state.",
      inputSchema: {}
    },
    async () => jsonResult(await androidDevices())
  );

  reg(
    mcp,
    "ui_android_adb",
    {
      title: "Run unrestricted ADB action",
      description: "Run arbitrary ADB arguments against an online Android device/emulator in trusted-local mode. Covers shell, install/uninstall, push/pull, package/activity/service control, forwarding, bugreport, and other ADB capabilities without an LCA approval layer.",
      inputSchema: {
        serial: z.string().optional(),
        args: z.array(z.string()).min(1).max(200),
        timeout_ms: z.number().int().min(1000).max(600_000).optional()
      }
    },
    async ({ serial, args, timeout_ms = 120_000 }) => {
      const selected = await selectAndroidSerial(serial);
      const result = await runAdb(selected, args, timeout_ms);
      return jsonResult({ ok: result.exit_code === 0, serial: selected, args, ...result });
    }
  );

  reg(
    mcp,
    "ui_android_screenshot",
    {
      title: "Capture Android screenshot",
      description: "Capture the current Android screen through ADB, persist the PNG under .agent/artifacts/android, and return it as image content for visual inspection.",
      inputSchema: { serial: z.string().optional() }
    },
    async ({ serial }) => {
      const selected = await selectAndroidSerial(serial);
      const png = await captureAndroidScreenshot(selected);
      const dir = await androidArtifactDir();
      const file = path.join(dir, `screen-${Date.now()}.png`);
      await writeFile(file, png);
      const metadata = { ok: true, serial: selected, path: file, bytes: png.length, mime_type: "image/png" };
      return {
        structuredContent: metadata,
        content: [
          { type: "text", text: JSON.stringify(metadata) },
          { type: "image", data: png.toString("base64"), mimeType: "image/png" }
        ]
      };
    }
  );

  reg(
    mcp,
    "ui_android_hierarchy",
    {
      title: "Read Android UI hierarchy",
      description: "Dump the current Android UIAutomator XML hierarchy for semantic element inspection.",
      inputSchema: { serial: z.string().optional(), max_chars: z.number().int().min(1000).max(1_000_000).optional() }
    },
    async ({ serial, max_chars = 250_000 }) => {
      const selected = await selectAndroidSerial(serial);
      const remote = `/sdcard/lca-window-${process.pid}.xml`;
      const dump = await runAdb(selected, ["shell", "uiautomator", "dump", remote], 20_000);
      if (dump.exit_code !== 0) throw new Error(dump.stderr || dump.stdout || "uiautomator dump failed");
      const xml = await runAdb(selected, ["exec-out", "cat", remote], 20_000);
      void runAdb(selected, ["shell", "rm", "-f", remote], 10_000);
      const text = String(xml.stdout || "");
      return jsonResult({
        ok: xml.exit_code === 0,
        serial: selected,
        truncated: text.length > max_chars,
        xml: text.slice(0, max_chars)
      });
    }
  );

  reg(
    mcp,
    "ui_android_input",
    {
      title: "Control Android device",
      description: "Send a bounded ADB input or app-control action: tap, swipe, text, keyevent, launch, or force_stop.",
      inputSchema: {
        serial: z.string().optional(),
        kind: z.enum(["tap", "swipe", "text", "keyevent", "launch", "force_stop"]),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        x2: z.number().int().optional(),
        y2: z.number().int().optional(),
        duration_ms: z.number().int().min(0).max(10_000).optional(),
        text: z.string().max(10_000).optional(),
        keycode: z.union([z.string(), z.number().int()]).optional(),
        package: z.string().max(300).optional()
      }
    },
    async (input) => {
      const selected = await selectAndroidSerial(input.serial);
      const args = androidInputArgs(input);
      const result = await runAdb(selected, args, 30_000);
      return jsonResult({ ok: result.exit_code === 0, serial: selected, kind: input.kind, ...result });
    }
  );

  reg(
    mcp,
    "ui_android_logcat",
    {
      title: "Read Android logcat",
      description: "Read a bounded tail of Android logcat for crash/debug diagnosis.",
      inputSchema: {
        serial: z.string().optional(),
        lines: z.number().int().min(10).max(5000).optional(),
        filter: z.string().max(200).optional()
      }
    },
    async ({ serial, lines = 500, filter }) => {
      const selected = await selectAndroidSerial(serial);
      const result = await runAdb(selected, ["logcat", "-d", "-t", String(lines)], 30_000);
      let output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
      if (filter) {
        const needle = filter.toLowerCase();
        output = output.split(/\r?\n/).filter((line) => line.toLowerCase().includes(needle)).join("\n");
      }
      return jsonResult({ ok: result.exit_code === 0, serial: selected, filter: filter || null, logcat: output.slice(-MAX_COMMAND_OUTPUT) });
    }
  );

  reg(
    mcp,
    "ui_android_record",
    {
      title: "Record Android screen",
      description: "Record a short Android screen video through ADB and pull the MP4 into .agent/artifacts/android.",
      inputSchema: {
        serial: z.string().optional(),
        duration_seconds: z.number().int().min(1).max(30).optional(),
        bit_rate: z.number().int().min(100_000).max(50_000_000).optional()
      }
    },
    async ({ serial, duration_seconds = 10, bit_rate = 8_000_000 }) => {
      const selected = await selectAndroidSerial(serial);
      const remote = `/sdcard/lca-record-${process.pid}-${Date.now()}.mp4`;
      const record = await runAdb(selected, [
        "shell", "screenrecord", "--time-limit", String(duration_seconds), "--bit-rate", String(bit_rate), remote
      ], (duration_seconds + 10) * 1000);
      if (record.exit_code !== 0) throw new Error(record.stderr || record.stdout || "screenrecord failed");
      const dir = await androidArtifactDir();
      const file = path.join(dir, `record-${Date.now()}.mp4`);
      const pull = await runAdb(selected, ["pull", remote, file], 60_000);
      void runAdb(selected, ["shell", "rm", "-f", remote], 10_000);
      if (pull.exit_code !== 0) throw new Error(pull.stderr || pull.stdout || "adb pull failed");
      const info = await stat(file);
      return jsonResult({ ok: true, serial: selected, path: file, bytes: info.size, duration_seconds });
    }
  );
}

async function fallbackCodeSymbolSearch(root, symbol, mode, limit = 500) {
  const pattern = `\\b${escapeRegexLiteral(symbol)}\\b`;
  let matches = null;
  let engine = "scan";
  if (RG_BIN) {
    matches = await ripgrepGrep(root, pattern, { regex: true, limit, glob: null });
    if (matches) engine = "ripgrep";
  }
  if (!matches) matches = await searchTree(root, pattern, { regex: true, limit, glob: null });
  if (mode === "definition") matches = [...matches].sort((left, right) => definitionCandidateScore(right.text, symbol) - definitionCandidateScore(left.text, symbol));
  return {
    engine: `${engine}-symbol-fallback`,
    semantic: false,
    symbol,
    mode,
    count: matches.length,
    matches,
    warning: "Fallback is text-based; use a language-specific LSP for semantic accuracy."
  };
}

function getAgentRunnerRegistry() {
  if (!agentRunnerRegistry) {
    agentRunnerRegistry = new AgentRunnerRegistry({
      events: RUNTIME_EVENTS,
      correlationId: () => ACTION_PIPELINE.currentCorrelationId(),
      codexOptions: { maxParallel: MAX_PARALLEL_TASKS }
    });
  }
  return agentRunnerRegistry;
}

async function prepareAgentTaskInput(input) {
  const cwd = resolvePath(input.cwd || ".");
  const files = resolveAgentPaths(cwd, input.files || []);
  const additionalDirectories = resolveAgentPaths(cwd, input.additional_directories || []);
  const scope = await WORKSPACE_PROTOCOL.assertPathsAllowed(input.task_id, files);
  return {
    ...input,
    cwd,
    files,
    additional_directories: additionalDirectories,
    scope
  };
}

function resolveAgentPaths(cwd, values) {
  return [...new Set((values || []).map((value) => resolveAgentPath(cwd, value)))];
}

function resolveAgentPath(cwd, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
}

async function androidDevices() {
  if (!ADB_BIN) return { ok: false, adb: false, devices: [], error: "adb unavailable" };
  const result = await spawnCapture(ADB_BIN, ["devices", "-l"], activePrimaryRoot(), 10_000);
  if (result.exit_code !== 0) return { ok: false, adb: false, devices: [], error: result.stderr || result.stdout || "adb unavailable" };
  const devices = String(result.stdout || "")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...details] = line.split(/\s+/);
      return { serial, state, details: details.join(" ") };
    });
  return { ok: true, adb: true, adb_path: ADB_BIN, devices };
}

async function selectAndroidSerial(requested) {
  const status = await androidDevices();
  if (!status.ok) throw new Error(status.error || "ADB is unavailable.");
  const online = status.devices.filter((device) => device.state === "device");
  if (requested) {
    if (!online.some((device) => device.serial === requested)) throw new Error(`Android device ${requested} is not online.`);
    return requested;
  }
  if (online.length === 1) return online[0].serial;
  if (online.length === 0) throw new Error("No online Android device/emulator found.");
  throw new Error(`Multiple Android devices are online (${online.map((device) => device.serial).join(", ")}); pass serial explicitly.`);
}

async function runAdb(serial, args, timeoutMs) {
  return spawnCapture(ADB_BIN || "adb", ["-s", serial, ...args], activePrimaryRoot(), timeoutMs);
}

function androidInputArgs(input) {
  if (input.kind === "tap") {
    if (!Number.isInteger(input.x) || !Number.isInteger(input.y)) throw new Error("tap requires integer x and y.");
    return ["shell", "input", "tap", String(input.x), String(input.y)];
  }
  if (input.kind === "swipe") {
    for (const key of ["x", "y", "x2", "y2"]) if (!Number.isInteger(input[key])) throw new Error(`swipe requires integer ${key}.`);
    return ["shell", "input", "swipe", String(input.x), String(input.y), String(input.x2), String(input.y2), String(input.duration_ms ?? 300)];
  }
  if (input.kind === "text") {
    if (typeof input.text !== "string") throw new Error("text action requires text.");
    return ["shell", "input", "text", input.text.replaceAll(" ", "%s")];
  }
  if (input.kind === "keyevent") {
    if (input.keycode === undefined) throw new Error("keyevent requires keycode.");
    return ["shell", "input", "keyevent", String(input.keycode)];
  }
  if (!input.package) throw new Error(`${input.kind} requires package.`);
  if (input.kind === "launch") return ["shell", "monkey", "-p", input.package, "-c", "android.intent.category.LAUNCHER", "1"];
  return ["shell", "am", "force-stop", input.package];
}

async function captureAndroidScreenshot(serial) {
  return await new Promise((resolve, reject) => {
    const child = spawn(ADB_BIN || "adb", ["-s", serial, "exec-out", "screencap", "-p"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks = [];
    let size = 0;
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Android screenshot timed out after 20 seconds."));
    }, 20_000);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 20 * 1024 * 1024) chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => { stderr = appendLimited(stderr, chunk.toString(), 8_000); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr || `adb screencap exited with code ${code}`));
      if (size > 20 * 1024 * 1024) return reject(new Error("Android screenshot exceeded the 20 MiB capture limit."));
      resolve(Buffer.concat(chunks));
    });
  });
}

async function androidArtifactDir() {
  const dir = path.join(activePrimaryRoot(), ".agent", "artifacts", "android");
  await mkdir(dir, { recursive: true });
  return dir;
}

function definitionCandidateScore(text, symbol) {
  const value = String(text || "");
  let score = 0;
  if (new RegExp(`\\b(class|interface|struct|enum|trait|type|def|fn|fun|function|const|let|var)\\s+${escapeRegexLiteral(symbol)}\\b`, "i").test(value)) score += 100;
  if (new RegExp(`\\b${escapeRegexLiteral(symbol)}\\s*[:=(]`, "i").test(value)) score += 30;
  return score;
}

function escapeRegexLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\function registerRepoIntelTools(mcp) {");
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
  COMPANION_QUICK_ACTIONS, COMPANION_WIDGET_LEGACY_URI, COMPANION_WIDGET_RESOURCE, COMPANION_WIDGET_URI,
  DBEAVER_SQL_ARTIFACT_LEGACY_URI, DBEAVER_SQL_ARTIFACT_RESOURCE, DBEAVER_SQL_ARTIFACT_URI,
  NOTION_PAGE_WIDGET_LEGACY_URI, NOTION_PAGE_WIDGET_MIME_TYPE, NOTION_PAGE_WIDGET_RESOURCE, NOTION_PAGE_WIDGET_URI,
  CONVERSATION_RUNTIME, PRIMARY_ROOT, ROOTS, WORKFLOW_COMMANDS, activeDiscoveryRoots,
  composeLcaPrompt, reg, resolvePath, slashCommandData, structuredJsonResult, workspaceSearchData
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

function consumeActionObservation(observation) {
  TOOL_METRICS.record({
    ts: observation.startedAt,
    tool: observation.name,
    surface: observation.surface,
    ok: observation.success,
    durationMs: observation.durationMs,
    inChars: observation.inChars,
    outChars: observation.outChars
  });
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
