import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_REVISION_TTL_MS = 250;
const DEFAULT_MAX_ENTRIES = 100;

export function isReusableDeterministicCommand(command) {
  const text = normalizeCommand(command);
  if (!text || /(?:&&|\|\||[;|<>`]|\$\()/u.test(text)) return false;
  return /^(?:npm\s+run\s+(?:typecheck|type-check|type:check)|pnpm\s+(?:run\s+)?(?:typecheck|type-check|type:check)|yarn\s+(?:typecheck|type-check|type:check)|npx\s+tsc\b[^\n]*--noEmit\b|(?:dart|flutter)\s+analyze\b|python(?:3)?\s+-m\s+(?:mypy|pyright)\b|(?:mypy|pyright)\b)/i.test(text);
}

export function isSetupCommand(command) {
  const text = normalizeCommand(command);
  if (!text || /(?:&&|\|\||[;|<>`])/u.test(text)) return false;
  return /^(?:flutter|dart)\s+pub\s+get\b|^(?:npm\s+(?:install|ci)|pnpm\s+install|yarn\s+install)\b|^(?:\.\/)?gradlew?\s+(?:dependencies|wrapper)\b/i.test(text);
}

export function createExecAccelerator(options) {
  const {
    runShellCommand,
    revisionToken = workspaceRevisionToken,
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    revisionTtlMs = DEFAULT_REVISION_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES
  } = options;
  const resultCache = new Map();
  const commandInFlight = new Map();
  const revisionCache = new Map();
  const revisionInFlight = new Map();

  async function warm(root) {
    return getRevision(root);
  }

  async function run(command, cwd, shell, timeoutMs, { reuse = "auto" } = {}) {
    const normalizedCommand = normalizeCommand(command);
    const normalizedRoot = path.resolve(cwd);
    const setup = isSetupCommand(normalizedCommand);
    const eligible = reuse !== "never" && isReusableDeterministicCommand(normalizedCommand);

    if (setup) {
      const setupKey = `setup\0${normalizedRoot}\0${shell || ""}\0${normalizedCommand}`;
      const pending = commandInFlight.get(setupKey);
      if (pending) {
        const result = await pending;
        return withAcceleration(result, { mode: "setup_dedupe", cache_hit: false, in_flight_join: true, reusable: false });
      }
      const operation = runShellCommand(command, normalizedRoot, shell, timeoutMs);
      commandInFlight.set(setupKey, operation);
      try {
        const result = await operation;
        return withAcceleration(result, { mode: "setup_dedupe", cache_hit: false, in_flight_join: false, reusable: false });
      } finally {
        if (commandInFlight.get(setupKey) === operation) commandInFlight.delete(setupKey);
      }
    }

    if (!eligible) {
      const result = await runShellCommand(command, normalizedRoot, shell, timeoutMs);
      return withAcceleration(result, {
        mode: "direct",
        cache_hit: false,
        in_flight_join: false,
        reusable: false,
        reason: reuse === "never" ? "reuse_disabled" : "command_not_analysis_only"
      });
    }

    const revision = await getRevision(normalizedRoot);
    if (!revision?.token) {
      const result = await runShellCommand(command, normalizedRoot, shell, timeoutMs);
      return withAcceleration(result, { mode: "deterministic", cache_hit: false, in_flight_join: false, reusable: false, reason: "revision_unavailable" });
    }
    const key = createHash("sha256")
      .update(`${revision.repo_root}\0${revision.token}\0${shell || ""}\0${normalizedCommand}`)
      .digest("hex");
    const cached = resultCache.get(key);
    const timestamp = now();
    if (cached && cached.expiresAt > timestamp) {
      touch(resultCache, key, cached);
      return withAcceleration(cached.result, { mode: "deterministic", cache_hit: true, in_flight_join: false, reusable: true, revision: revision.token });
    }
    if (cached) resultCache.delete(key);

    const pending = commandInFlight.get(key);
    if (pending) {
      const result = await pending;
      return withAcceleration(result, { mode: "deterministic", cache_hit: true, in_flight_join: true, reusable: true, revision: revision.token });
    }

    const operation = runShellCommand(command, normalizedRoot, shell, timeoutMs);
    commandInFlight.set(key, operation);
    try {
      const result = await operation;
      if (result?.exit_code === 0 && !result?.timed_out) {
        resultCache.set(key, { expiresAt: timestamp + ttlMs, result: cloneResult(result) });
        trimMap(resultCache, maxEntries);
      }
      return withAcceleration(result, { mode: "deterministic", cache_hit: false, in_flight_join: false, reusable: true, revision: revision.token });
    } finally {
      if (commandInFlight.get(key) === operation) commandInFlight.delete(key);
    }
  }

  async function getRevision(root) {
    const normalizedRoot = path.resolve(root);
    const timestamp = now();
    const cached = revisionCache.get(normalizedRoot);
    if (cached && cached.expiresAt > timestamp) return cached.value;
    const pending = revisionInFlight.get(normalizedRoot);
    if (pending) return pending;
    const operation = Promise.resolve(revisionToken(normalizedRoot)).catch(() => null);
    revisionInFlight.set(normalizedRoot, operation);
    try {
      const value = await operation;
      revisionCache.set(normalizedRoot, { expiresAt: timestamp + revisionTtlMs, value });
      trimMap(revisionCache, maxEntries);
      return value;
    } finally {
      if (revisionInFlight.get(normalizedRoot) === operation) revisionInFlight.delete(normalizedRoot);
    }
  }

  function stats() {
    return {
      result_cache_entries: resultCache.size,
      revision_cache_entries: revisionCache.size,
      in_flight_commands: commandInFlight.size,
      in_flight_revisions: revisionInFlight.size
    };
  }

  return { run, warm, stats };
}

export async function workspaceRevisionToken(cwd) {
  let repoRoot;
  let head;
  let status;
  try {
    const rootResult = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5_000, windowsHide: true });
    repoRoot = String(rootResult.stdout || "").trim();
    if (!repoRoot) return null;
    const [headResult, statusResult] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, timeout: 5_000, windowsHide: true }),
      execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: repoRoot, timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    ]);
    head = String(headResult.stdout || "").trim();
    status = String(statusResult.stdout || "");
  } catch {
    return null;
  }

  const hash = createHash("sha256");
  hash.update(head || "no-head");
  const entries = parsePorcelainZ(status);
  for (const entry of entries) {
    hash.update("\0path\0");
    hash.update(entry.path);
    try {
      const content = await readFile(path.join(repoRoot, entry.path));
      hash.update(createHash("sha256").update(content).digest("hex"));
    } catch {
      hash.update("missing");
    }
  }
  return { repo_root: path.resolve(repoRoot), token: hash.digest("hex"), dirty_files: entries.length };
}

export async function runCommandDag(nodes, runNode, options = {}) {
  const maxConcurrency = Math.max(1, Math.min(8, Number(options.maxConcurrency || 4)));
  const stopOnFailure = options.stopOnFailure === true;
  validateDag(nodes);
  const byId = new Map(nodes.map((node, index) => [node.id, index]));
  const pending = new Set(nodes.map((_, index) => index));
  const running = new Map();
  const results = new Array(nodes.length);
  let failureSeen = false;

  const launch = (index) => {
    const node = nodes[index];
    pending.delete(index);
    const operation = Promise.resolve(runNode(node, index))
      .then((result) => {
        results[index] = result;
        if (!isSuccessfulResult(result)) failureSeen = true;
      })
      .catch((error) => {
        failureSeen = true;
        results[index] = { id: node.id, exit_code: null, timed_out: false, error: String(error?.message || error) };
      })
      .finally(() => running.delete(index));
    running.set(index, operation);
  };

  while (pending.size || running.size) {
    let progressed = false;
    for (const index of [...pending]) {
      if (running.size >= maxConcurrency) break;
      const node = nodes[index];
      const dependencies = node.depends_on || [];
      const depResults = dependencies.map((id) => results[byId.get(id)]);
      if (depResults.some((result) => result == null)) continue;
      if (depResults.some((result) => !isSuccessfulResult(result))) {
        pending.delete(index);
        results[index] = { id: node.id, skipped: true, skip_reason: "dependency_failed", exit_code: null, timed_out: false };
        progressed = true;
        continue;
      }
      if (stopOnFailure && failureSeen) {
        pending.delete(index);
        results[index] = { id: node.id, skipped: true, skip_reason: "stopped_after_failure", exit_code: null, timed_out: false };
        progressed = true;
        continue;
      }
      launch(index);
      progressed = true;
    }
    if (running.size) {
      await Promise.race(running.values());
      continue;
    }
    if (pending.size && !progressed) throw new Error("Command DAG could not make progress; dependency cycle detected.");
  }
  return results;
}

function validateDag(nodes) {
  const ids = new Set();
  for (let index = 0; index < nodes.length; index += 1) {
    const id = String(nodes[index]?.id || `cmd-${index}`);
    nodes[index].id = id;
    if (ids.has(id)) throw new Error(`Duplicate command DAG id: ${id}`);
    ids.add(id);
  }
  for (const node of nodes) {
    for (const dependency of node.depends_on || []) {
      if (!ids.has(dependency)) throw new Error(`Unknown command DAG dependency '${dependency}' for '${node.id}'.`);
      if (dependency === node.id) throw new Error(`Command DAG node '${node.id}' cannot depend on itself.`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Command DAG cycle detected at '${id}'.`);
    visiting.add(id);
    for (const dependency of byId.get(id)?.depends_on || []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

function parsePorcelainZ(output) {
  const tokens = String(output || "").split("\0").filter(Boolean);
  const result = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4) continue;
    const status = token.slice(0, 2);
    const file = token.slice(3);
    if (file) result.push({ status, path: file });
    if ((status.includes("R") || status.includes("C")) && tokens[index + 1]) {
      result.push({ status, path: tokens[index + 1] });
      index += 1;
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function isSuccessfulResult(result) {
  return result && result.exit_code === 0 && result.skipped !== true;
}

function normalizeCommand(command) {
  return String(command || "").trim().replace(/\s+/g, " ");
}

function cloneResult(result) {
  return result && typeof result === "object" ? { ...result } : result;
}

function withAcceleration(result, acceleration) {
  return { ...(result || {}), acceleration };
}

function touch(map, key, value) {
  map.delete(key);
  map.set(key, value);
}

function trimMap(map, maxEntries) {
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
