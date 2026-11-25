import { randomUUID } from "node:crypto";
import { z } from "zod";

export function createBasicToolRegistrar(options) {
  const {
    reg, jsonResult, textResult, isoNow, readNotes, writeNotes, workspaceInfoPayload, performanceFollow, improvementReport,
    dependencyFeedReport, runtimeTraceReport, workspaceStateRegistry, resolvePath, projectRootForPath, PRIMARY_ROOT
  } = options;

  function stateFor(cwd, filesTouched = []) {
    const candidate = cwd || filesTouched.find((value) => typeof value === "string" && value.trim()) || ".";
    return workspaceStateRegistry.forRoot(projectRootForPath(resolvePath(candidate)));
  }

  function registerBasicTools(mcp) {
    reg(
      mcp,
      "ping",
      {
        title: "Ping",
        description: "Check whether the local coding agent is reachable.",
        inputSchema: { message: z.string().optional().describe("Optional message to echo back.") }
      },
      async ({ message }) => textResult(`Local coding agent online (trusted-local).${message ? ` Echo: ${message}` : ""}`)
    );

    reg(
      mcp,
      "workspace_info",
      {
        title: "Workspace info",
        description: "Return project roots, runtime limits, host information, and transport posture.",
        inputSchema: {}
      },
      async () => jsonResult(workspaceInfoPayload())
    );

    reg(
      mcp,
      "performance_follow",
      {
        title: "Performance follow",
        description: "Query opt-in long-lived privacy-safe timing rollups for coding work. Returns p50/p95 wall-clock, bottlenecks, cache efficiency, cold/warm context, and command families without storing raw task text, commands, patches, or output.",
        inputSchema: {
          path: z.string().optional().describe("Optional project/workspace path. Omit for all recorded roots."),
          window_days: z.number().int().min(1).max(3650).optional().describe("Lookback window. Default 30 days."),
          task_class: z.enum(["user", "internal", "synthetic", "unknown", "all"]).optional().describe("Default user."),
          compact: z.boolean().optional().describe("Return fewer grouped rows. Default false."),
          task_id: z.string().min(1).max(100).optional().describe("Zoom into one exact recorded task id."),
          latest_task: z.boolean().optional().describe("Zoom into the latest matching task after path/window/task_class filters."),
          include_timeline: z.boolean().optional().describe("Include ordered per-tool/provider/Jev timeline for the selected result set.")
        }
      },
      async ({ path: requestedPath, window_days = 30, task_class = "user", compact = false, task_id, latest_task = false, include_timeline = false }) => {
        let root = null;
        if (requestedPath) root = projectRootForPath(resolvePath(requestedPath));
        return jsonResult(performanceFollow.report({
          root,
          windowDays: window_days,
          taskClass: task_class,
          compact,
          taskId: task_id,
          latestTask: latest_task,
          includeTimeline: include_timeline
        }));
      }
    );

    reg(
      mcp,
      "improvement_candidates",
      {
        title: "Improvement candidates",
        description: "Detect, deduplicate, rank, and return evidence-driven LCA self-improvement candidates for one workspace. Analysis-only; never patches code.",
        inputSchema: {
          path: z.string().optional().describe("Project/workspace path. Defaults to the primary workspace."),
          window_days: z.number().int().min(1).max(3650).optional().describe("Performance evidence lookback. Default 30 days."),
          task_class: z.enum(["user", "internal", "synthetic", "unknown", "all"]).optional().describe("Performance task class. Default user."),
          category: z.enum(["PERFORMANCE", "RELIABILITY", "CORRECTNESS", "SECURITY", "TEST_QUALITY", "CODE_HEALTH", "DEPENDENCY", "AGENT_STRATEGY"]).optional(),
          limit: z.number().int().min(1).max(50).optional().describe("Maximum ranked candidates. Default 10."),
          refresh: z.boolean().optional().describe("Detect and ingest candidates from current evidence before ranking. Default true.")
        }
      },
      async ({ path: requestedPath, window_days = 30, task_class = "user", category, limit = 10, refresh = true }) => {
        const root = projectRootForPath(resolvePath(requestedPath || "."));
        return jsonResult(await improvementReport({
          root,
          windowDays: window_days,
          taskClass: task_class,
          category: category || null,
          limit,
          refresh
        }));
      }
    );

    reg(
      mcp,
      "dependency_feed",
      {
        title: "Dependency candidate feed",
        description: "Read a local/self-hosted Renovate JSON or JSONL feed and convert dependency updates into DEPENDENCY improvement candidates. Analysis-only: this tool never runs Renovate updates, package installs, file mutations, commits, pushes, or auto-merge.",
        inputSchema: {
          path: z.string().optional().describe("Project/workspace root. Defaults to the active workspace."),
          report_path: z.string().optional().describe("Optional local Renovate feed/report path. Defaults to RENOVATE_FEED_PATH or standard report names."),
          ingest: z.boolean().optional().describe("Ingest parsed candidates into the existing improvement candidate store. Default true.")
        }
      },
      async ({ path: requestedPath, report_path, ingest = true }) => {
        if (typeof dependencyFeedReport !== "function") {
          return jsonResult({
            engine: "renovate",
            available: false,
            ok: false,
            reason: "dependency_feed_unavailable",
            analysis_only: true,
            auto_apply: false,
            auto_merge: false,
            candidates: []
          });
        }
        const root = projectRootForPath(resolvePath(requestedPath || "."));
        return jsonResult(await dependencyFeedReport({
          root,
          reportPath: report_path || null,
          ingest
        }));
      }
    );

    reg(
      mcp,
      "tool_trace",
      {
        title: "Runtime trace waterfall",
        description: "Return a compact metadata-only parent/child waterfall from the local RuntimeEventStore. When enabled, performance_follow is the historical profiler; this action is for per-trace timing inspection.",
        inputSchema: {
          correlation_id: z.string().min(1).max(200).optional(),
          trace_limit: z.number().int().min(1).max(20).optional(),
          span_limit: z.number().int().min(1).max(2000).optional()
        }
      },
      async ({ correlation_id, trace_limit = 5, span_limit = 200 }) => {
        if (typeof runtimeTraceReport !== "function") {
          return jsonResult({
            kind: "runtime_trace_waterfall",
            source: "RuntimeEventStore",
            authoritative_history: "performance_follow",
            available: false,
            groups: []
          });
        }
        return jsonResult(runtimeTraceReport({
          correlationId: correlation_id || null,
          traceLimit: trace_limit,
          spanLimit: span_limit
        }));
      }
    );

    reg(
      mcp,
      "lca",
      {
        title: "LCA status",
        description: "Short alias for workspace_info. Use this when the user says only 'lca' in a fresh chat to check the active LCA workspace.",
        inputSchema: {}
      },
      async () => jsonResult(workspaceInfoPayload())
    );

    reg(
      mcp,
      "save_note",
      {
        title: "Save note",
        description: "Save a note on the local machine for later retrieval.",
        inputSchema: { title: z.string().min(1), body: z.string().min(1) }
      },
      async ({ title, body }) => {
        const notes = await readNotes();
        const note = { id: randomUUID(), title, body, created_at: isoNow() };
        notes.unshift(note);
        await writeNotes(notes);
        return textResult(`Saved note "${title}" (${note.id}).`);
      }
    );

    reg(
      mcp,
      "list_notes",
      {
        title: "List notes",
        description: "List previously saved notes.",
        inputSchema: { limit: z.number().int().min(1).max(50).optional() }
      },
      async ({ limit = 10 }) => {
        const notes = (await readNotes()).slice(0, limit);
        if (!notes.length) return textResult("No notes saved yet.");
        return textResult(notes.map((n) => `- ${n.title} (${n.id})\n  ${n.body}`).join("\n"));
      }
    );

    reg(
      mcp,
      "checkpoint",
      {
        title: "Save a progress checkpoint",
        description: "Save a COMPACT summary of progress so the user can start a fresh, fast chat and you can continue. Call this when the conversation gets long/slow, then tell the user to open a new chat and you will call resume().",
        inputSchema: {
          summary: z.string().min(1).describe("What has been done so far, the goal, and current state — concise."),
          next_steps: z.array(z.string()).optional().describe("Ordered remaining steps."),
          files_touched: z.array(z.string()).optional().describe("Key files involved."),
          cwd: z.string().optional().describe("Workspace/project this checkpoint belongs to. Defaults to the workspace inferred from files_touched, then the primary workspace.")
        }
      },
      async ({ summary, next_steps = [], files_touched = [], cwd }) => {
        const state = stateFor(cwd, files_touched);
        const saved = await state.checkpoint.saveManual({ summary, next_steps, files_touched });
        if (!saved.ok) return jsonResult({ ok: false, error: saved.error });
        return textResult("Checkpoint saved. Tell the user to open a NEW chat (resets the heavy context), then call resume() to continue.");
      }
    );

    reg(
      mcp,
      "resume",
      {
        title: "Resume from last checkpoint",
        description: "Load the last checkpoint saved by checkpoint(). Call this FIRST in a fresh chat to continue prior work without the old heavy context.",
        inputSchema: {
          cwd: z.string().optional().describe("Workspace/project checkpoint to load. Defaults to the primary workspace.")
        }
      },
      async ({ cwd }) => {
        const state = stateFor(cwd);
        const cp = await state.checkpoint.readCheckpoint();
        return cp ? jsonResult(cp) : textResult("No checkpoint saved yet.");
      }
    );
  }

  // ----------------------------------------------------------------------------
  // Filesystem read tools
  // ----------------------------------------------------------------------------

  return registerBasicTools;
}
