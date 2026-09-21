import { createHash } from "node:crypto";
import path from "node:path";
import { createTaskStateCore } from "./task-state.mjs";
import { createCheckpointCore } from "./checkpoint-core.mjs";

export function createWorkspaceStateRegistry(options) {
  const { DATA_DIR, isoNow, comparePath } = options;
  const cache = new Map();

  function forRoot(root) {
    const normalizedRoot = path.resolve(root);
    const key = comparePath ? comparePath(normalizedRoot) : normalizedRoot;
    const existing = cache.get(key);
    if (existing) return existing;

    const workspaceId = createHash("sha256").update(key).digest("hex").slice(0, 16);
    const agentStateDir = path.join(normalizedRoot, ".agent", "state");
    const taskPlanPath = path.join(agentStateDir, "current-task.json");
    const decisionsPath = path.join(agentStateDir, "decisions.md");
    const workspaceDataDir = path.join(DATA_DIR, "workspaces", workspaceId);
    const checkpointPath = path.join(workspaceDataDir, "checkpoint.json");
    const taskState = createTaskStateCore({ TASK_PLAN_PATH: taskPlanPath, isoNow });
    const checkpoint = createCheckpointCore({
      CHECKPOINT_PATH: checkpointPath,
      AGENT_STATE_DIR: agentStateDir,
      TASK_PLAN_PATH: taskPlanPath,
      isoNow,
      taskState
    });
    const value = {
      root: normalizedRoot,
      workspaceId,
      taskState,
      checkpoint,
      paths: {
        agentStateDir,
        taskPlanPath,
        decisionsPath,
        workspaceDataDir,
        checkpointPath
      }
    };
    cache.set(key, value);
    return value;
  }

  return { forRoot };
}
