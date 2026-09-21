// Local Coding Agent — shared workspace protocol helpers
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MEMORY_TYPES = new Set(["fact", "assumption", "decision", "open_question"]);
const MEMORY_SOURCES = new Set(["user", "repo", "assistant", "system", "tool"]);
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function defaultMemoryVault(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.AGENT_MEMORY_VAULT) return path.resolve(env.AGENT_MEMORY_VAULT);
  if (platform === "win32") {
    return path.resolve(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "LocalCodingAgent", "Vault");
  }
  if (platform === "darwin") {
    return path.resolve(home, "Library", "Application Support", "LocalCodingAgent", "Vault");
  }
  return path.resolve(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "local-coding-agent", "vault");
}

export class WorkspaceProtocol {
  constructor({ primaryRoot, projectId, stateDir, vaultDir, now = () => new Date().toISOString(), uuid = randomUUID }) {
    this.primaryRoot = path.resolve(primaryRoot);
    this.projectId = String(projectId);
    this.stateDir = path.resolve(stateDir);
    this.vaultDir = path.resolve(vaultDir);
    this.now = now;
    this.uuid = uuid;
    this.tasksDir = path.join(this.stateDir, "tasks");
    this.activeTaskPath = path.join(this.stateDir, "active-task.json");
  }

  async init() {
    await Promise.all([
      mkdir(path.join(this.vaultDir, "Global"), { recursive: true }),
      mkdir(path.join(this.vaultDir, "Projects", this.projectId), { recursive: true }),
      mkdir(path.join(this.vaultDir, "Tasks", this.projectId), { recursive: true }),
      mkdir(this.tasksDir, { recursive: true })
    ]);
    const readme = path.join(this.vaultDir, "README.md");
    if (!existsSync(readme)) {
      await writeFile(readme, renderVaultReadme(), "utf8");
    }
  }

  memoryStatus() {
    return {
      vault_path: this.vaultDir,
      obsidian_compatible: true,
      project_id: this.projectId,
      folders: {
        global: path.join(this.vaultDir, "Global"),
        project: path.join(this.vaultDir, "Projects", this.projectId),
        tasks: path.join(this.vaultDir, "Tasks", this.projectId)
      }
    };
  }

  async pinContext({ key, value, scope = "project", source = "user", tags = [], links = [], replace = true }) {
    validateMemoryKey(key);
    if (!MEMORY_SOURCES.has(source)) throw new Error(`Unsupported memory source: ${source}`);
    const existing = await this.findContextPath(key, scope);
    const target = existing || this.contextPath(key, scope);
    if (!replace && existing) throw new Error(`Context already exists: ${key}`);
    const createdAt = existing ? (await this.readContextFile(existing)).metadata.created_at : this.now();
    const metadata = {
      lca_type: "memory",
      key,
      scope,
      source,
      project_id: scope === "project" ? this.projectId : null,
      created_at: createdAt,
      updated_at: this.now(),
      tags: dedupeStrings(["lca-memory", ...tags]),
      links: dedupeStrings(links)
    };
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, renderContextNote(metadata, value), "utf8");
    return { ok: true, key, scope, path: target, metadata };
  }

  async listContext({ scope = "all", query = "", limit = 50 } = {}) {
    const roots = [];
    if (scope === "all" || scope === "global") roots.push(path.join(this.vaultDir, "Global"));
    if (scope === "all" || scope === "project") roots.push(path.join(this.vaultDir, "Projects", this.projectId));
    const files = [];
    for (const root of roots) files.push(...await listMarkdownFiles(root));
    const needle = query.trim().toLowerCase();
    const items = [];
    for (const file of files) {
      const note = await this.readContextFile(file).catch(() => null);
      if (!note || note.metadata.lca_type !== "memory") continue;
      const haystack = `${note.metadata.key || ""}\n${note.body}\n${(note.metadata.tags || []).join(" ")}`.toLowerCase();
      if (needle && !haystack.includes(needle)) continue;
      items.push({
        key: note.metadata.key,
        scope: note.metadata.scope,
        source: note.metadata.source,
        updated_at: note.metadata.updated_at,
        tags: note.metadata.tags || [],
        preview: compactWhitespace(note.body).slice(0, 240),
        path: file
      });
    }
    items.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return { vault_path: this.vaultDir, count: items.length, items: items.slice(0, limit) };
  }

  async explainContext({ key, scope = "project" }) {
    const target = await this.findContextPath(key, scope);
    if (!target) throw new Error(`No context named ${key} in ${scope} scope.`);
    const note = await this.readContextFile(target);
    return { key, scope, path: target, metadata: note.metadata, value: note.body };
  }

  async removeContext({ key, scope = "project" }) {
    const target = await this.findContextPath(key, scope);
    if (!target) throw new Error(`No context named ${key} in ${scope} scope.`);
    await rm(target, { force: false });
    return { ok: true, key, scope, removed: target };
  }

  contextPath(key, scope) {
    validateMemoryKey(key);
    if (scope !== "global" && scope !== "project") throw new Error("scope must be global or project");
    const folder = this.contextFolder(scope);
    return path.join(folder, `${safeSlug(key)}--${shortHash(key)}.md`);
  }

  contextFolder(scope) {
    if (scope !== "global" && scope !== "project") throw new Error("scope must be global or project");
    return scope === "global"
      ? path.join(this.vaultDir, "Global")
      : path.join(this.vaultDir, "Projects", this.projectId);
  }

  async findContextPath(key, scope) {
    validateMemoryKey(key);
    const deterministic = this.contextPath(key, scope);
    if (existsSync(deterministic)) return deterministic;
    for (const file of await listMarkdownFiles(this.contextFolder(scope))) {
      const note = await this.readContextFile(file).catch(() => null);
      if (note?.metadata?.lca_type === "memory" && note.metadata.key === key && note.metadata.scope === scope) return file;
    }
    return null;
  }

  async readContextFile(file) {
    return parseMarkdownNote(await readFile(file, "utf8"));
  }

  async createTaskBrief(input) {
    const now = this.now();
    const taskId = input.task_id || `task-${now.slice(0, 10).replaceAll("-", "")}-${this.uuid().slice(0, 8)}`;
    validateTaskId(taskId);
    if (existsSync(this.taskPath(taskId)) && !input.replace) throw new Error(`Task already exists: ${taskId}`);
    const prior = existsSync(this.taskPath(taskId)) ? await this.getTask(taskId) : null;
    const task = {
      task_id: taskId,
      goal: String(input.goal).trim(),
      scope: dedupeStrings(input.scope || []),
      out_of_scope: dedupeStrings(input.out_of_scope || []),
      constraints: dedupeStrings(input.constraints || []),
      definition_of_done: dedupeStrings(input.definition_of_done || []),
      test_policy: input.test_policy || "changed_tests",
      commit_policy: input.commit_policy || "do_not_commit",
      confirmation: input.confirmation || "never",
      status: input.status || prior?.status || "active",
      scope_guard: normalizeScopeGuard(input.scope_guard || prior?.scope_guard || {}),
      knowledge: prior?.knowledge || { facts: [], assumptions: [], decisions: [], open_questions: [] },
      created_at: prior?.created_at || now,
      updated_at: now
    };
    await this.saveTask(task, true);
    return task;
  }

  async getTask(taskId) {
    const resolved = taskId || await this.activeTaskId();
    if (!resolved) throw new Error("No active task brief. Call task_brief first or pass task_id.");
    validateTaskId(resolved);
    return JSON.parse(await readFile(this.taskPath(resolved), "utf8"));
  }

  async activeTaskId() {
    try {
      return JSON.parse(await readFile(this.activeTaskPath, "utf8")).task_id || null;
    } catch {
      return null;
    }
  }

  async saveTask(task, makeActive = false) {
    validateTaskId(task.task_id);
    task.updated_at = this.now();
    await mkdir(this.tasksDir, { recursive: true });
    await writeFile(this.taskPath(task.task_id), `${JSON.stringify(task, null, 2)}\n`, "utf8");
    await writeFile(this.taskNotePath(task.task_id), renderTaskNote({ ...task, project_id: this.projectId }), "utf8");
    if (makeActive) {
      await writeFile(this.activeTaskPath, `${JSON.stringify({ task_id: task.task_id, updated_at: task.updated_at }, null, 2)}\n`, "utf8");
    }
  }

  taskPath(taskId) {
    validateTaskId(taskId);
    return path.join(this.tasksDir, `${taskId}.json`);
  }

  taskNotePath(taskId) {
    validateTaskId(taskId);
    return path.join(this.vaultDir, "Tasks", this.projectId, `${taskId}.md`);
  }

  async scopeGuard({ action = "get", task_id, allowed_paths = [], denied_paths = [] }) {
    const task = await this.getTask(task_id);
    if (action === "get") return { task_id: task.task_id, ...normalizeScopeGuard(task.scope_guard) };
    if (action === "clear") {
      task.scope_guard = { allowed_paths: [], denied_paths: [] };
    } else if (action === "set") {
      task.scope_guard = normalizeScopeGuard({ allowed_paths, denied_paths });
    } else {
      throw new Error("scope_guard action must be get, set, or clear");
    }
    await this.saveTask(task);
    return { ok: true, task_id: task.task_id, ...task.scope_guard };
  }

  async assertPathsAllowed(taskId, candidatePaths) {
    const resolved = taskId || await this.activeTaskId();
    if (!resolved) return { task_id: null, guarded: false, checked_paths: [] };
    const task = await this.getTask(resolved);
    const guard = normalizeScopeGuard(task.scope_guard);
    if (!guard.allowed_paths.length && !guard.denied_paths.length) {
      return { task_id: task.task_id, guarded: false, checked_paths: candidatePaths.map(String) };
    }
    const checked = candidatePaths.filter(Boolean).map((candidate) => this.relativeWorkspacePath(candidate));
    for (const candidate of checked) {
      const denied = guard.denied_paths.find((pattern) => matchesPathPattern(candidate, pattern));
      if (denied) throw new Error(`Scope guard denied ${candidate} via pattern ${denied} (task ${task.task_id}).`);
      if (guard.allowed_paths.length && !guard.allowed_paths.some((pattern) => matchesPathPattern(candidate, pattern))) {
        throw new Error(`Scope guard does not allow ${candidate} (task ${task.task_id}).`);
      }
    }
    return { task_id: task.task_id, guarded: true, checked_paths: checked };
  }

  relativeWorkspacePath(candidate) {
    const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(this.primaryRoot, candidate);
    const rel = path.relative(this.primaryRoot, absolute);
    if (!rel || rel === ".") return ".";
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path is outside primary workspace: ${candidate}`);
    return rel.split(path.sep).join("/");
  }

  async knowledgeState({ action = "list", task_id, type, text, source = "assistant", why, id }) {
    const task = await this.getTask(task_id);
    task.knowledge ||= { facts: [], assumptions: [], decisions: [], open_questions: [] };
    if (action === "list") return { task_id: task.task_id, knowledge: task.knowledge };
    if (action === "add") {
      if (!MEMORY_TYPES.has(type)) throw new Error(`Unsupported knowledge type: ${type}`);
      if (!MEMORY_SOURCES.has(source)) throw new Error(`Unsupported knowledge source: ${source}`);
      const entry = {
        id: id || this.uuid(),
        text: String(text || "").trim(),
        source,
        why: why ? String(why) : null,
        status: "active",
        created_at: this.now(),
        updated_at: this.now()
      };
      if (!entry.text) throw new Error("knowledge text is required");
      task.knowledge[knowledgeBucket(type)].push(entry);
      await this.saveTask(task);
      return { ok: true, task_id: task.task_id, type, entry };
    }
    const match = findKnowledgeEntry(task.knowledge, id);
    if (!match) throw new Error(`Knowledge entry not found: ${id}`);
    if (action === "resolve") {
      match.entry.status = "resolved";
      match.entry.updated_at = this.now();
      if (text) match.entry.resolution = String(text);
    } else if (action === "remove") {
      task.knowledge[match.bucket].splice(match.index, 1);
    } else {
      throw new Error("knowledge_state action must be list, add, resolve, or remove");
    }
    await this.saveTask(task);
    return { ok: true, task_id: task.task_id, action, id };
  }

  async intentCheck({ task_id, expected_files = [], assumptions = [], proposed_actions = [], risk = "low" } = {}) {
    const task = await this.getTask(task_id);
    const payload = {
      task_id: task.task_id,
      goal: task.goal,
      scope: task.scope,
      out_of_scope: task.out_of_scope,
      constraints: task.constraints,
      definition_of_done: task.definition_of_done,
      expected_files: dedupeStrings(expected_files),
      proposed_actions: dedupeStrings(proposed_actions),
      assumptions: dedupeStrings([
        ...(task.knowledge?.assumptions || []).filter((entry) => entry.status === "active").map((entry) => entry.text),
        ...assumptions
      ]),
      decisions: (task.knowledge?.decisions || []).filter((entry) => entry.status === "active").map((entry) => entry.text),
      open_questions: (task.knowledge?.open_questions || []).filter((entry) => entry.status === "active").map((entry) => entry.text),
      scope_guard: normalizeScopeGuard(task.scope_guard),
      confirmation_mode: task.confirmation,
      confirmation_required: false
    };
    return { ...payload, intent_checksum: shortHash(stableStringify(payload), 16) };
  }

  async handoffBase(taskId) {
    const task = await this.getTask(taskId).catch(() => null);
    return {
      task_id: task?.task_id || null,
      goal: task?.goal || null,
      status: task?.status || null,
      scope: task?.scope || [],
      out_of_scope: task?.out_of_scope || [],
      constraints: task?.constraints || [],
      definition_of_done: task?.definition_of_done || [],
      scope_guard: normalizeScopeGuard(task?.scope_guard || {}),
      knowledge: task?.knowledge || { facts: [], assumptions: [], decisions: [], open_questions: [] },
      memory_vault: this.memoryStatus()
    };
  }
}

export function validateTaskDag(tasks) {
  const ids = new Set();
  for (const task of tasks) {
    validateTaskId(task.id);
    if (ids.has(task.id)) throw new Error(`Duplicate parallel task id: ${task.id}`);
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dependency of task.depends_on || []) {
      if (!ids.has(dependency)) throw new Error(`Task ${task.id} depends on unknown task ${dependency}.`);
      if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself.`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (id, trail = []) => {
    if (visiting.has(id)) throw new Error(`parallel_tasks dependency cycle: ${[...trail, id].join(" -> ")}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).depends_on || []) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
  return { ids: [...ids], by_id: byId };
}

export function buildResultDigest({ ok, exitCode = null, timedOut = false, stdout = "", stderr = "", taskId = null, changedFiles = [], recommendedNextAction = null, summary: customSummary = null }) {
  const stdoutLines = usefulLines(stdout);
  const stderrLines = usefulLines(stderr);
  const facts = [];
  const blockers = [];
  if (exitCode !== null) facts.push(`exit_code=${exitCode}`);
  if (timedOut) blockers.push("command timed out");
  const passed = `${stdout}\n${stderr}`.match(/(\d+)\s+passed\b/i)?.[1];
  const failed = `${stdout}\n${stderr}`.match(/(\d+)\s+failed\b/i)?.[1];
  if (passed) facts.push(`${passed} passed`);
  if (failed) facts.push(`${failed} failed`);
  if (ok && stdoutLines.length) facts.push(...stdoutLines.slice(-3).map((line) => `output: ${line}`));
  if (!ok) blockers.push(...(stderrLines.length ? stderrLines : stdoutLines).slice(-4));
  const summary = customSummary || (ok
    ? timedOut ? "Command timed out." : "Command completed successfully."
    : timedOut ? "Command failed because it timed out." : `Command failed${exitCode === null ? "" : ` with exit code ${exitCode}`}.`);
  return {
    ok,
    task_id: taskId,
    summary,
    facts: dedupeStrings(facts),
    changed_files: dedupeStrings(changedFiles),
    blockers: dedupeStrings(blockers),
    recommended_next_action: recommendedNextAction || (!ok ? "Inspect the failing step output and correct the first root cause." : null),
    raw_output_available: Boolean(stdout || stderr)
  };
}

export function matchesPathPattern(candidate, pattern) {
  const value = normalizePatternPath(candidate);
  const normalized = normalizePatternPath(pattern);
  if (!normalized) return false;
  if (!/[?*]/.test(normalized)) return value === normalized || value.startsWith(`${normalized}/`);
  return globToRegExp(normalized).test(value);
}

function renderVaultReadme() {
  return `---\nlca_type: vault\ncreated_by: Local Coding Agent\n---\n\n# Local Coding Agent Memory\n\nThis is an Obsidian-compatible persistent memory vault.\n\n- \`Global/\`: memories shared across projects.\n- \`Projects/\`: project-scoped memories with explicit provenance.\n- \`Tasks/\`: task briefs, decisions, assumptions, and handoff state.\n\nLCA writes Markdown with YAML frontmatter and Obsidian \`[[wikilinks]]\`. You may edit these notes in Obsidian; avoid placing secrets in the vault.\n`;
}

function renderContextNote(metadata, value) {
  const links = metadata.links || [];
  const linkSection = links.length ? `\n\n## Links\n\n${links.map((link) => `- [[${link}]]`).join("\n")}` : "";
  return `${renderFrontmatter(metadata)}\n# ${metadata.key}\n\n${String(value).trim()}${linkSection}\n`;
}

function renderTaskNote(task) {
  const metadata = {
    lca_type: "task",
    task_id: task.task_id,
    project_id: task.project_id || null,
    status: task.status,
    created_at: task.created_at,
    updated_at: task.updated_at,
    tags: ["lca-task"]
  };
  const section = (title, items) => `## ${title}\n\n${items?.length ? items.map((item) => `- ${item}`).join("\n") : "- _None_"}`;
  const knowledge = task.knowledge || {};
  return `${renderFrontmatter(metadata)}\n# ${task.goal}\n\n${section("Scope", task.scope)}\n\n${section("Out of scope", task.out_of_scope)}\n\n${section("Constraints", task.constraints)}\n\n${section("Definition of done", task.definition_of_done)}\n\n## Policies\n\n- Test: ${task.test_policy}\n- Commit: ${task.commit_policy}\n- Confirmation: ${task.confirmation}\n\n${section("Facts", (knowledge.facts || []).map(renderKnowledgeLine))}\n\n${section("Assumptions", (knowledge.assumptions || []).map(renderKnowledgeLine))}\n\n${section("Decisions", (knowledge.decisions || []).map(renderKnowledgeLine))}\n\n${section("Open questions", (knowledge.open_questions || []).map(renderKnowledgeLine))}\n`;
}

function renderKnowledgeLine(entry) {
  return `${entry.text} _(source: ${entry.source}, status: ${entry.status})_`;
}

function renderFrontmatter(metadata) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function parseMarkdownNote(content) {
  if (!content.startsWith("---\n")) return { metadata: {}, body: content.trim() };
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return { metadata: {}, body: content.trim() };
  const metadata = {};
  for (const line of content.slice(4, end).split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    try { metadata[key] = JSON.parse(raw); } catch { metadata[key] = raw; }
  }
  let body = content.slice(end + 5).trim();
  body = body.replace(/^# .*?\n+/, "").replace(/\n+## Links\n[\s\S]*$/, "").trim();
  return { metadata, body };
}

async function listMarkdownFiles(root) {
  const files = [];
  const walk = async (dir) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(target);
    }
  };
  await walk(root);
  return files;
}

function normalizeScopeGuard(value) {
  return {
    allowed_paths: dedupeStrings(value.allowed_paths || []).map(normalizePatternPath).filter(Boolean),
    denied_paths: dedupeStrings(value.denied_paths || []).map(normalizePatternPath).filter(Boolean)
  };
}

function knowledgeBucket(type) {
  return type === "fact" ? "facts"
    : type === "assumption" ? "assumptions"
      : type === "decision" ? "decisions"
        : "open_questions";
}

function findKnowledgeEntry(knowledge, id) {
  for (const bucket of ["facts", "assumptions", "decisions", "open_questions"]) {
    const index = (knowledge[bucket] || []).findIndex((entry) => entry.id === id);
    if (index >= 0) return { bucket, index, entry: knowledge[bucket][index] };
  }
  return null;
}

function validateMemoryKey(key) {
  if (!String(key || "").trim()) throw new Error("memory key is required");
  if (String(key).includes("..") || /[\\\0]/.test(String(key))) throw new Error("memory key contains an unsafe path sequence");
}

function validateTaskId(taskId) {
  if (!TASK_ID_RE.test(String(taskId || ""))) throw new Error(`Invalid task id: ${taskId}`);
}

function safeSlug(value) {
  return String(value).normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "memory";
}

function shortHash(value, length = 8) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function dedupeStrings(items) {
  return [...new Set((items || []).map((item) => String(item).trim()).filter(Boolean))];
}

function compactWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function usefulLines(value) {
  return String(value || "").split(/\r?\n/).map(compactWhitespace).filter(Boolean).slice(-20);
}

function normalizePatternPath(value) {
  return String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

function globToRegExp(glob) {
  let source = "^";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      source += ".*";
      index++;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  source += "$";
  return new RegExp(source);
}
