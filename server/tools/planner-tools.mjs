import { appendFile, mkdir } from "node:fs/promises";
import { z } from "zod";

export function createPlannerToolRegistrar(options) {
  const {
    reg, jsonResult, textResult, isoNow,
    workspaceStateRegistry, resolvePath, projectRootForPath, PRIMARY_ROOT,
    persistImprovementMemory
  } = options;

  function stateFor(cwd) {
    const root = projectRootForPath(resolvePath(cwd || "."));
    return workspaceStateRegistry.forRoot(root);
  }

  async function refreshCheckpoint(state, reason) {
    try { await state.checkpoint.refresh({ reason }); } catch { /* automatic checkpoint is best-effort */ }
  }

  function registerPlannerTools(mcp) {
    reg(
      mcp,
      "task_plan",
      {
        title: "Task plan",
        description: "Create or update the current task plan. Stores goal + steps in .agent/state/current-task.json.",
        inputSchema: {
          goal: z.string().min(1).describe("High-level goal description."),
          steps: z.array(z.string()).min(1).describe("Ordered list of steps to complete the goal."),
          cwd: z.string().optional().describe("Workspace/project whose task state should be updated. Defaults to the primary workspace.")
        }
      },
      async ({ goal, steps, cwd }) => {
        const state = stateFor(cwd);
        await mkdir(state.paths.agentStateDir, { recursive: true });
        const plan = await state.taskState.create(goal, steps);
        await refreshCheckpoint(state, "task_plan");
        return jsonResult({ ok: true, goal: plan.goal, steps_count: plan.steps.length, root: state.root, path: state.paths.taskPlanPath });
      }
    );

    reg(
      mcp,
      "task_state",
      {
        title: "Task state",
        description: "Get or update the current task plan. Call with no args to read; pass set_step_done/add_steps/status to update.",
        inputSchema: {
          set_step_done: z.number().int().min(0).optional().describe("Mark step N (0-indexed) as done."),
          add_steps: z.array(z.string()).optional().describe("Append new steps to the plan."),
          status: z.string().optional().describe("Set overall status string."),
          cwd: z.string().optional().describe("Workspace/project whose task state should be read or updated. Defaults to the primary workspace.")
        }
      },
      async ({ set_step_done, add_steps, status, cwd }) => {
        const state = stateFor(cwd);
        const hasMutation = set_step_done !== undefined || Boolean(add_steps?.length) || status !== undefined;
        const plan = hasMutation
          ? await state.taskState.update({ setStepDone: set_step_done, addSteps: add_steps, status })
          : await state.taskState.read();
        if (!plan) return textResult("No task plan found for this workspace. Call task_plan to create one.");
        if (hasMutation) await refreshCheckpoint(state, "task_state");
        const done = plan.steps.filter((s) => s.done).length;
        const total = plan.steps.length;
        return jsonResult({ ...plan, progress: `${done}/${total}` });
      }
    );

    reg(
      mcp,
      "decision_log",
      {
        title: "Decision log",
        description: "Append a decision + reasoning to decisions.md in .agent/state/.",
        inputSchema: {
          decision: z.string().min(1).describe("What was decided."),
          why: z.string().min(1).describe("Why this decision was made."),
          cwd: z.string().optional().describe("Workspace/project whose decision log should be updated. Defaults to the primary workspace."),
          files: z.array(z.string().min(1).max(1000)).max(50).optional(),
          memory_kind: z.enum(["accepted_improvement"]).optional(),
          memory: z.object({
            candidate_id: z.string().min(1).max(200),
            category: z.string().min(1).max(100),
            component: z.string().min(1).max(300),
            problem: z.string().max(4000),
            evidence: z.string().max(8000),
            solution: z.string().max(8000),
            before: z.string().max(8000),
            after: z.string().max(8000),
            regression: z.boolean(),
            verdict: z.literal("improved"),
            verification: z.string().max(8000).optional(),
            regression_rules: z.array(z.string().min(1).max(1000)).max(50).optional()
          }).optional()
        }
      },
      async ({ decision, why, cwd, files = [], memory_kind, memory }) => {
        const state = stateFor(cwd);
        await mkdir(state.paths.agentStateDir, { recursive: true });
        const entry = `\n## ${isoNow()}\n\n**Decision:** ${decision}\n\n**Why:** ${why}\n`;
        await appendFile(state.paths.decisionsPath, entry, "utf8");
        try { await state.taskState.recordDecision(decision, why); } catch { /* preserve legacy decision log */ }
        let memoryPersisted = null;
        if (memory_kind === "accepted_improvement") {
          if (!memory || typeof persistImprovementMemory !== "function") {
            memoryPersisted = false;
          } else {
            await persistImprovementMemory({
              root: state.root,
              candidateId: memory.candidate_id,
              category: memory.category,
              component: memory.component,
              problem: memory.problem,
              evidence: memory.evidence,
              solution: memory.solution,
              before: memory.before,
              after: memory.after,
              regression: memory.regression,
              verdict: memory.verdict,
              files,
              verification: memory.verification,
              regressionRules: memory.regression_rules
            });
            memoryPersisted = true;
          }
        }
        await refreshCheckpoint(state, "decision_log");
        return jsonResult({
          ok: true,
          root: state.root,
          appended_to: state.paths.decisionsPath,
          ...(memoryPersisted !== null ? { memory_persisted: memoryPersisted } : {})
        });
      }
    );
  }

  // Also update checkpoint to snapshot current-task.json
  const _origCheckpoint = null; // we'll patch via the registration


  return registerPlannerTools;
}
