import { stat } from "node:fs/promises";
import path from "node:path";

export function createCompanionContextSearch(options) {
  const {
    ROOTS, PRIMARY_ROOT, WORKFLOW_COMMANDS, comparePath, isWithinRoots, discoverSkills,
    listRepoFilesFast, scanSymbols, resolvePath, toRel
  } = options;

  function normalizePickerQuery(value, prefix = "@") {
    let text = String(value || "").trim();
    if (prefix && text.startsWith(prefix)) text = text.slice(prefix.length);
    if (text === "/" || text === "./") return "";
    if (text.startsWith("/") && prefix === "@") text = text.slice(1);
    try { text = decodeURIComponent(text); } catch { /* Incomplete percent escape while the user is typing. */ }
    return text.trim();
  }

  function tokenizeSearch(value) {
    return String(value || "")
      .toLowerCase()
      .split(/[\s\\/_.:-]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function scoreSearchCandidate(rawQuery, fields, { base = 0, emptyScore = 1 } = {}) {
    const query = String(rawQuery || "").trim().toLowerCase();
    if (!query) return emptyScore + base;
    const tokens = tokenizeSearch(query);
    if (!tokens.length) return emptyScore + base;
    const haystack = fields.filter(Boolean).join(" ").toLowerCase();
    const words = haystack.split(/[\s\\/_.:-]+/).filter(Boolean);
    const compactHaystack = haystack.replace(/[\s\\/_.:-]+/g, "");
    const compactQuery = query.replace(/[\s\\/_.:-]+/g, "");
    let score = base;

    if (haystack === query) score += 120;
    if (words.some((word) => word === query)) score += 90;
    if (haystack.includes(query)) score += 65;
    if (compactQuery && compactHaystack.includes(compactQuery)) score += 45;

    for (const token of tokens) {
      if (words.some((word) => word === token)) score += 36;
      if (words.some((word) => word.startsWith(token))) score += 26;
      if (haystack.includes(token)) score += 18;
      const fuzzy = bestFuzzyWordScore(token, words);
      score += fuzzy;
    }
    return score;
  }

  function exactSearchBonus(query, candidate, bonus = 500) {
    const left = String(query || "").trim().toLowerCase();
    const right = String(candidate || "").trim().toLowerCase();
    return left && left === right ? bonus : 0;
  }

  function bestFuzzyWordScore(token, words) {
    if (!token || token.length < 3) return 0;
    let best = 0;
    for (const word of words) {
      if (!word || Math.abs(word.length - token.length) > 2) continue;
      const distance = boundedEditDistance(token, word, token.length <= 5 ? 1 : 2);
      if (distance === 0) best = Math.max(best, 28);
      else if (distance === 1) best = Math.max(best, 16);
      else if (distance === 2 && token.length >= 6) best = Math.max(best, 9);
    }
    return best;
  }

  function boundedEditDistance(a, b, maxDistance) {
    if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    const curr = new Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      let rowMin = curr[0];
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        rowMin = Math.min(rowMin, curr[j]);
      }
      if (rowMin > maxDistance) return maxDistance + 1;
      for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
    }
    return prev[b.length];
  }

  function pathDepth(rel) {
    if (!rel || rel === ".") return 0;
    return rel.split(/[\\/]+/).filter(Boolean).length;
  }

  function normalizeInclude(include, fallback) {
    return new Set(Array.isArray(include) && include.length ? include : fallback);
  }

  function configuredRootForPath(abs) {
    const matches = ROOTS.filter((root) => isWithinRoots(abs, [root]));
    return matches.sort((a, b) => b.length - a.length)[0] || abs;
  }

  function projectRootLabels(roots = ROOTS) {
    const parts = roots.map((root) => path.resolve(root).split(path.sep).filter(Boolean));
    const labels = new Map();
    roots.forEach((root, index) => {
      let depth = 1;
      let label = parts[index].slice(-depth).join("/") || root;
      while (depth < parts[index].length) {
        const collisions = parts.filter((segments) => segments.slice(-depth).join("/") === label).length;
        if (collisions === 1) break;
        depth++;
        label = parts[index].slice(-depth).join("/") || root;
      }
      labels.set(comparePath(root), label);
    });
    return labels;
  }

  function encodeMentionPath(value) {
    return String(value || "").split("/").map((segment) => encodeURIComponent(segment)).join("/");
  }

  function projectRelativePath(projectRoot, abs) {
    const rel = path.relative(projectRoot, abs).split(path.sep).join("/");
    return rel || ".";
  }

  function normalizeWorkspaceSearchRoots(rootDirs) {
    const input = Array.isArray(rootDirs) ? rootDirs : [rootDirs];
    const seen = new Set();
    const roots = [];
    for (const root of input) {
      if (!root) continue;
      const resolved = path.resolve(root);
      const key = comparePath(resolved);
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push(resolved);
    }
    return roots.length ? roots : ROOTS;
  }

  async function workspaceSearchData(rootDirs, query, { include, limit = 30 } = {}) {
    const q = normalizePickerQuery(query, "@");
    const wanted = normalizeInclude(include, ["file", "folder", "symbol", "skill"]);
    const searchRoots = normalizeWorkspaceSearchRoots(rootDirs);
    const labels = projectRootLabels();
    const candidates = [];
    const engines = [];
    const maxList = Math.max(4000, limit * 120);
    const maxPerRoot = Math.max(1000, Math.ceil(maxList / searchRoots.length));

    for (const rootDir of searchRoots) {
      const projectRoot = configuredRootForPath(rootDir);
      const project = labels.get(comparePath(projectRoot)) || path.basename(projectRoot) || projectRoot;
      const listed = await listRepoFilesFast(rootDir, maxPerRoot);
      engines.push(listed.engine);

      if (wanted.has("folder")) {
        const scopeRel = projectRelativePath(projectRoot, rootDir);
        const scopeLabel = scopeRel === "." ? `${project}/` : `${project}/${scopeRel}/`;
        const scopeMention = scopeLabel.replace(/\/$/, "");
        const scopeScore = scoreSearchCandidate(q, [project, scopeRel, scopeLabel, rootDir], { base: 12, emptyScore: 36 - pathDepth(scopeRel) }) + exactSearchBonus(q, scopeMention);
        if (!q || scopeScore > 12) {
          candidates.push({
            type: "folder",
            path: toRel(rootDir),
            label: scopeLabel,
            mention: encodeMentionPath(scopeMention),
            detail: `project root · ${projectRoot}`,
            project,
            project_root: projectRoot,
            score: scopeScore
          });
        }
      }

      if (wanted.has("file")) {
        for (const abs of listed.files) {
          const rel = projectRelativePath(projectRoot, abs);
          const display = `${project}/${rel}`;
          const base = path.basename(rel);
          const score = scoreSearchCandidate(q, [display, rel, toRel(abs), base, project], { emptyScore: 20 - pathDepth(rel) }) + exactSearchBonus(q, display);
          if (q && score <= 0) continue;
          candidates.push({
            type: "file",
            path: toRel(abs),
            label: display,
            mention: encodeMentionPath(display),
            detail: `file · ${project} · ${path.dirname(rel) === "." ? "root" : path.dirname(rel)}`,
            project,
            project_root: projectRoot,
            score
          });
        }
      }

      if (wanted.has("folder")) {
        const dirs = new Set();
        for (const abs of listed.files) {
          const rel = path.relative(rootDir, abs).split(path.sep).join("/");
          const parts = rel.split("/").filter(Boolean);
          for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
        }
        for (const localRel of dirs) {
          const abs = path.resolve(rootDir, localRel);
          const rel = projectRelativePath(projectRoot, abs);
          const display = `${project}/${rel}/`;
          const folderMention = display.replace(/\/$/, "");
          const score = scoreSearchCandidate(q, [display, rel, localRel, path.basename(rel), project], { base: 4, emptyScore: 24 - pathDepth(rel) }) + exactSearchBonus(q, folderMention);
          if (q && score <= 4) continue;
          candidates.push({
            type: "folder",
            path: toRel(abs),
            label: display,
            mention: encodeMentionPath(folderMention),
            detail: `folder · ${project}`,
            project,
            project_root: projectRoot,
            score
          });
        }
      }

      if (wanted.has("symbol")) {
        const symbols = await scanSymbols(rootDir, { maxFiles: 600, maxMatches: 2000, files: listed.files });
        for (const sym of symbols) {
          const abs = path.isAbsolute(sym.path) ? sym.path : path.resolve(PRIMARY_ROOT, sym.path);
          const rel = projectRelativePath(projectRoot, abs);
          const display = `${project}/${rel}`;
          const symbolMention = `${project}:${sym.name}`;
          const score = scoreSearchCandidate(q, [sym.name, sym.kind, display, rel, project, symbolMention], { base: 8, emptyScore: 0 }) + exactSearchBonus(q, symbolMention);
          if (!q || score <= 8) continue;
          candidates.push({
            type: "symbol",
            path: toRel(abs),
            line: sym.line,
            symbol: sym.name,
            kind: sym.kind,
            label: `${sym.name} — ${display}:${sym.line}`,
            mention: encodeMentionPath(symbolMention),
            detail: `${sym.kind} symbol · ${project}`,
            project,
            project_root: projectRoot,
            score
          });
        }
      }
    }

    if (wanted.has("skill")) {
      const skills = await discoverSkills();
      for (const skill of skills) {
        const score = scoreSearchCandidate(q, [skill.name, skill.description], { base: 6, emptyScore: 0 });
        if (!q || score <= 6) continue;
        candidates.push({
          type: "skill",
          skill: skill.name,
          path: toRel(skill.skillFile),
          label: `skill:${skill.name}`,
          detail: skill.description || "skill",
          score
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
    const results = candidates.slice(0, limit).map((item) => ({ ...item, score: Math.round(item.score * 100) / 100 }));
    const uniqueEngines = [...new Set(engines)];
    return {
      query,
      normalized_query: q,
      roots: searchRoots.map((root) => toRel(root)),
      engine: uniqueEngines.length === 1 ? uniqueEngines[0] : `multi:${uniqueEngines.join("+")}`,
      count: results.length,
      results
    };
  }

  async function slashCommandData(query, { include, limit = 30 } = {}) {
    const q = normalizePickerQuery(query, "/").replace(/^#/, "");
    const wanted = normalizeInclude(include, ["workflow", "mode", "skill"]);
    const items = [];
    for (const cmd of WORKFLOW_COMMANDS) {
      if (cmd.name === "plan") continue;
      const group = cmd.type === "mode" ? "mode" : "workflow";
      if (!wanted.has(group)) continue;
      const score = scoreSearchCandidate(q, [cmd.command, cmd.name, cmd.label, cmd.description], { base: group === "mode" ? 6 : 4, emptyScore: 20 });
      if (q && score <= 0) continue;
      items.push({ type: group, command: cmd.command, name: cmd.name, label: cmd.label, description: cmd.description, score });
    }
    if (wanted.has("skill")) {
      const skills = await discoverSkills();
      for (const skill of skills) {
        const score = scoreSearchCandidate(q, [skill.name, skill.description, `/skill ${skill.name}`], { base: 3, emptyScore: 0 });
        if (q && score <= 3) continue;
        items.push({ type: "skill", command: `/skill:${skill.name}`, name: skill.name, label: `Use skill: ${skill.name}`, description: skill.description, score });
      }
    }
    items.sort((a, b) => b.score - a.score || a.command.localeCompare(b.command));
    const commands = items.slice(0, limit).map((item) => ({ ...item, score: Math.round(item.score * 100) / 100 }));
    return { query, normalized_query: q, count: commands.length, commands };
  }

  function extractSlashTokens(input) {
    const tokens = [];
    const re = /(^|\s)\/([a-z][a-z0-9_-]*(?::[a-z0-9_.-]+)?)/gi;
    let match;
    while ((match = re.exec(input))) tokens.push(match[2]);
    return tokens;
  }

  function extractMentionTokens(input) {
    const tokens = [];
    const re = /(^|\s)@([^\s]+)/g;
    let match;
    while ((match = re.exec(input))) {
      const raw = match[2].replace(/[,.!?;:]+$/g, "");
      if (raw) tokens.push(raw);
    }
    return tokens;
  }

  function stripPromptControlTokens(input) {
    return String(input || "")
      .replace(/(^|\s)\/[a-z][a-z0-9_-]*(?::[a-z0-9_.-]+)?/gi, " ")
      .replace(/(^|\s)@[^\s]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function workflowByName(name) {
    const key = String(name || "").replace(/^\//, "").toLowerCase();
    return WORKFLOW_COMMANDS.find((cmd) => cmd.name === key || cmd.command.slice(1) === key) || null;
  }

  async function composeLcaPrompt(input, rootDirs, { mode, selectedContext = [], includeContextPack = true } = {}) {
    const slashTokens = extractSlashTokens(input);
    const mentionTokens = extractMentionTokens(input);
    const explicitMode = slashTokens.map((token) => token.split(":")[0]).find((token) => workflowByName(token)) || mode;
    const workflow = workflowByName(explicitMode) || null;
    const skillTokens = slashTokens
      .map((token) => token.match(/^skill:(.+)$/i)?.[1])
      .filter(Boolean);
    const resolved = [];
    const unresolved = [];

    for (const item of selectedContext) {
      try {
        const abs = resolvePath(item);
        const info = await stat(abs).catch(() => null);
        const projectRoot = configuredRootForPath(abs);
        const project = projectRootLabels().get(comparePath(projectRoot)) || path.basename(projectRoot) || projectRoot;
        const rel = projectRelativePath(projectRoot, abs);
        resolved.push({
          type: info?.isDirectory() ? "folder" : "file",
          path: toRel(abs),
          label: `${project}/${rel}`,
          project,
          project_root: projectRoot
        });
      } catch {
        unresolved.push(item);
      }
    }

    for (const token of mentionTokens) {
      const search = await workspaceSearchData(rootDirs, token, { include: ["file", "folder", "symbol", "skill"], limit: 1 });
      if (search.results.length) resolved.push(search.results[0]);
      else unresolved.push(`@${token}`);
    }

    const deduped = [];
    const seen = new Set();
    for (const item of resolved) {
      const key = `${item.type}:${item.path || item.skill || item.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }

    const task = stripPromptControlTokens(input) || input.trim();
    const lines = [];
    if (workflow) {
      lines.push(`Use LCA ${workflow.label}.`);
      lines.push(workflow.prompt);
    } else {
      lines.push("Use LCA workspace tools when useful.");
    }
    if (includeContextPack) {
      lines.push("Start by calling workspace_context with this task so filesystem, native semantic analysis, CodeGraph, and AgentMemory are all searched; do not ask me to copy file paths unless the @ context is ambiguous.");
    }
    if (skillTokens.length) {
      lines.push("", "Requested skills:");
      for (const skill of skillTokens) lines.push(`- ${skill}`);
      lines.push("Call read_skill for each requested skill before editing or reviewing.");
    }
    if (deduped.length) {
      lines.push("", "Selected context:");
      for (const item of deduped) {
        const loc = item.line ? `${item.path}:${item.line}` : item.path || item.skill || item.label;
        lines.push(`- ${item.type}: ${loc}`);
      }
    }
    if (unresolved.length) {
      lines.push("", "Unresolved @ mentions:");
      for (const item of unresolved) lines.push(`- ${item}`);
    }
    lines.push("", "Task:", task);

    const suggested = workflow?.name === "plan"
      ? ["workspace_context", "read_many", "task_plan"]
      : workflow?.name === "review"
        ? ["workspace_context", "review_diff", "read_many"]
        : ["workspace_context", "read_many", "apply_patch"];

    return {
      mode: workflow?.name || null,
      slash_commands: slashTokens.map((token) => `/${token}`),
      skills: skillTokens,
      mentions: mentionTokens.map((token) => `@${token}`),
      selected_context: deduped,
      unresolved_mentions: unresolved,
      task,
      suggested_tools: suggested,
      prompt: lines.join("\n")
    };
  }


  return { workspaceSearchData, slashCommandData, composeLcaPrompt, projectRootLabels };
}
