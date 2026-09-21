import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./file-state.mjs";

export function createCheckpointCore(options) {
  const { CHECKPOINT_PATH, AGENT_STATE_DIR, TASK_PLAN_PATH, isoNow, taskState } = options;

  async function refresh({ reason = "automatic", manual = null } = {}) {
    try {
      const task = await taskState.read();
      const checkpoint = buildCheckpoint(task, reason, manual, isoNow());
      await mkdir(path.dirname(CHECKPOINT_PATH), { recursive: true });
      await writeFileAtomic(CHECKPOINT_PATH, Buffer.from(`${JSON.stringify(checkpoint, null, 2)}\n`, "utf8"));
      return { ok: true, checkpoint };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  async function saveManual({ summary, next_steps = [], files_touched = [] }) {
    await archiveTaskSnapshot();
    return refresh({
      reason: "manual",
      manual: {
        summary: String(summary || "").trim(),
        next_steps: compactList(next_steps, 30),
        files_touched: compactList(files_touched, 80)
      }
    });
  }

  async function readCheckpoint() {
    try { return JSON.parse(await readFile(CHECKPOINT_PATH, "utf8")); } catch { return null; }
  }

  async function archiveTaskSnapshot() {
    try {
      if (!existsSync(TASK_PLAN_PATH)) return;
      const cpStateDir = path.join(AGENT_STATE_DIR, "checkpoints");
      await mkdir(cpStateDir, { recursive: true });
      const taskPlan = await readFile(TASK_PLAN_PATH, "utf8");
      await writeFile(path.join(cpStateDir, `task-${Date.now()}.json`), taskPlan, "utf8");
    } catch {
      // Archival is best-effort; the primary checkpoint still proceeds.
    }
  }

  return { refresh, saveManual, readCheckpoint };
}

function buildCheckpoint(task, reason, manual, savedAt) {
  const steps = Array.isArray(task?.steps) ? task.steps : [];
  const pending = steps.filter((step) => !step.done).map((step) => step.text).slice(0, 30);
  const done = steps.filter((step) => step.done).length;
  const files = compactList([
    ...(task?.changed_files || []),
    ...(manual?.files_touched || [])
  ], 100);
  const checkpoint = {
    version: 2,
    saved_at: savedAt,
    reason,
    summary: manual?.summary || task?.goal || "",
    next_steps: manual?.next_steps?.length ? manual.next_steps : pending,
    files_touched: files,
    task: task ? {
      goal: task.goal,
      status: task.status,
      progress: `${done}/${steps.length}`,
      pending_steps: pending,
      changed_files: compactList(task.changed_files || [], 100),
      discoveries: (task.discoveries || []).slice(-20),
      decisions: (task.decisions || []).slice(-20),
      blockers: (task.blockers || []).slice(-20),
      last_verification: task.last_verification || null,
      recent_events: (task.events || []).slice(-30),
      updated: task.updated || null
    } : null
  };
  return checkpoint;
}

function compactList(values, limit) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text.slice(0, 1000));
  }
  return result.slice(-limit);
}
