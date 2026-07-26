// Local Coding Agent — deterministic AgentMemory session summaries
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

function pushUnique(target, value, limit = 50) {
  if (target.length >= limit || typeof value !== "string") return;
  const normalized = value.trim();
  if (!normalized || target.includes(normalized)) return;
  target.push(normalized);
}

function parseInput(value) {
  if (typeof value !== "string") return null;
  const prefix = value.split(" | ", 1)[0].trim();
  if (!prefix.startsWith("{") || !prefix.endsWith("}")) return null;
  try {
    return JSON.parse(prefix);
  } catch {
    return null;
  }
}

function extractField(value, field) {
  const parsed = parseInput(value);
  if (parsed && typeof parsed[field] === "string") return parsed[field].trim();
  if (typeof value !== "string") return "";
  const match = value.match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!match) return "";
  try {
    return JSON.parse(`"${match[1]}"`).trim();
  } catch {
    return match[1].trim();
  }
}

function collectPaths(value, target, key = "") {
  if (target.length >= 50 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, target, key);
    return;
  }
  if (typeof value === "object") {
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      collectPaths(nestedValue, target, nestedKey);
    }
    return;
  }
  if (typeof value !== "string") return;
  const pathKey = /(^|_)(path|file|files|cwd|root|changed_files)$/.test(key);
  if (!pathKey) return;
  const normalized = value.trim();
  if (!normalized || (!normalized.includes("/") && !normalized.includes("\\"))) return;
  pushUnique(target, normalized, 50);
}

function toConcept(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function createDeterministicSessionSummary(session, observations, now = () => new Date()) {
  const items = Array.isArray(observations) ? observations : [];
  const toolCounts = new Map();
  const tasks = [];
  const decisions = [];
  const files = [];
  const concepts = [];
  let failures = 0;

  for (const observation of items) {
    if (!observation || typeof observation !== "object") continue;
    const title = typeof observation.title === "string" ? observation.title.trim() : "";
    const narrative = typeof observation.narrative === "string" ? observation.narrative : "";
    const subtitle = typeof observation.subtitle === "string" ? observation.subtitle : "";
    if (title) toolCounts.set(title, (toolCounts.get(title) ?? 0) + 1);

    const task = extractField(narrative, "task") || extractField(subtitle, "task");
    pushUnique(tasks, task, 8);
    if (observation.type === "error"
      || /"success"\s*:\s*false/i.test(narrative)
      || /\|\s*(?:failed|failure|error)\b/i.test(narrative)) {
      failures += 1;
    }
    if (observation.type === "decision" || /decision/i.test(title)) {
      pushUnique(decisions, narrative || subtitle || title, 8);
    }

    for (const file of Array.isArray(observation.files) ? observation.files : []) {
      pushUnique(files, file, 50);
    }
    collectPaths(parseInput(narrative), files);
    collectPaths(parseInput(subtitle), files);
    for (const concept of Array.isArray(observation.concepts) ? observation.concepts : []) {
      pushUnique(concepts, concept, 30);
    }
    pushUnique(concepts, toConcept(title), 30);
  }

  const tools = [...toolCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([tool, count]) => `${tool}:${count}`);
  const project = typeof session?.project === "string" && session.project.trim()
    ? session.project.trim()
    : "unknown project";
  const fallbackTitle = typeof session?.firstPrompt === "string" && session.firstPrompt.trim()
    ? session.firstPrompt.trim()
    : typeof session?.summary === "string" && session.summary.trim()
      ? session.summary.trim()
      : `${project} session`;
  const title = (tasks[0] || fallbackTitle).slice(0, 120).trim();
  const startedAt = typeof session?.startedAt === "string" ? session.startedAt : "unknown";
  const endedAt = typeof session?.endedAt === "string" ? session.endedAt : "not recorded";
  const narrative = [
    `Deterministic zero-LLM summary for ${project}.`,
    `Session ${session?.id ?? "unknown"} ran from ${startedAt} to ${endedAt} and captured ${items.length} observations.`,
    `Tools: ${tools.length ? tools.join(", ") : "none captured"}.`,
    `Failures detected: ${failures}.`,
    `Tasks: ${tasks.length ? tasks.join(" | ") : "none captured"}.`,
    `Files: ${files.length ? files.join(", ") : "none captured"}.`,
    `Decisions: ${decisions.length ? decisions.join(" | ") : "none captured"}.`
  ].join("\n").slice(0, 4_000);

  pushUnique(concepts, "zero-llm", 30);
  pushUnique(concepts, "deterministic-summary", 30);
  return {
    sessionId: session?.id ?? "unknown",
    project,
    createdAt: now().toISOString(),
    title,
    narrative,
    keyDecisions: decisions,
    filesModified: files,
    concepts,
    observationCount: items.length,
    mode: "deterministic"
  };
}

export function deterministicSummaryRuntimeSource(patchMarker) {
  return [
    `// ${patchMarker}: persist useful summaries without an external LLM.`,
    pushUnique.toString(),
    parseInput.toString(),
    extractField.toString(),
    collectPaths.toString(),
    toConcept.toString(),
    createDeterministicSessionSummary.toString()
  ].join("\n");
}
