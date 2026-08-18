import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CODEX_RUNNER_CAPABILITIES } from "../agent-runner.mjs";
import { COMPACT_GROUP_DEFINITIONS, COMPACT_TOOL_DESCRIPTIONS } from "../dist/interfaces/mcp/compact-mcp-interface.js";
import { TARGET_TOOL_CATALOG } from "../dist/interfaces/mcp/tool-catalog.js";
import { KNOWN_RUNTIME_EVENT_TYPES } from "../dist/runtime/runtime-event.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(here, "../../docs/generated");
const check = process.argv.includes("--check");

const artifacts = new Map([
  ["tool-catalog.md", renderToolCatalog()],
  ["action-catalog.md", renderActionCatalog()],
  ["event-catalog.md", renderEventCatalog()],
  ["provider-catalog.md", renderProviderCatalog()],
  ["runtime-graph.md", renderRuntimeGraph()]
]);

if (check) {
  const stale = [];
  for (const [name, expected] of artifacts) {
    const target = path.join(outputDir, name);
    const actual = await readFile(target, "utf8").catch(() => null);
    if (actual !== expected) stale.push(name);
  }
  if (stale.length) {
    console.error(`Generated architecture contracts are stale or missing: ${stale.join(", ")}`);
    console.error("Run: npm run docs:generate");
    process.exitCode = 1;
  } else {
    console.log(`Architecture contracts are current (${artifacts.size} files).`);
  }
} else {
  await mkdir(outputDir, { recursive: true });
  for (const [name, content] of artifacts) await writeFile(path.join(outputDir, name), content, "utf8");
  console.log(`Generated ${artifacts.size} architecture contracts in ${outputDir}`);
}

function renderToolCatalog() {
  const rows = TARGET_TOOL_CATALOG.map((tool, index) => `| ${index + 1} | \`${tool.name}\` | ${escapeCell(tool.description)} |`).join("\n");
  return generatedHeader("Model-facing tool catalog") + `\nTotal compact tools: **${TARGET_TOOL_CATALOG.length}**.\n\n| # | Tool | Purpose |\n| ---: | --- | --- |\n${rows}\n`;
}

function renderActionCatalog() {
  const sections = Object.entries(COMPACT_GROUP_DEFINITIONS).map(([facade, definition]) => {
    const aliases = Object.entries(definition.aliases);
    const actions = [...new Set([
      ...aliases.map(([, target]) => target),
      ...[...(definition.exact ?? [])]
    ])].sort();
    const aliasText = aliases.length
      ? aliases.sort(([a], [b]) => a.localeCompare(b)).map(([alias, target]) => `- \`${alias}\` → \`${target}\``).join("\n")
      : "- _None_";
    const actionText = actions.length ? actions.map((action) => `\`${action}\``).join(", ") : "_prefix-discovered only_";
    return `## \`${facade}\`\n\n${escapeMarkdown(COMPACT_TOOL_DESCRIPTIONS[facade] ?? "")}\n\n- Default: \`${definition.defaultAction}\`\n- Prefix: ${definition.prefix ? `\`${definition.prefix}*\`` : "none"}\n- Explicit backend actions: ${actionText}\n\nAliases:\n${aliasText}\n`;
  }).join("\n");
  return generatedHeader("Compact facade action catalog") + `\nFacades: **${Object.keys(COMPACT_GROUP_DEFINITIONS).length}**.\n\n${sections}`;
}

function renderEventCatalog() {
  const rows = KNOWN_RUNTIME_EVENT_TYPES.map((type) => {
    const owner = type.startsWith("agent/") ? "AgentRunner runtime" : "ActionExecutionPipeline";
    const persistence = "append-only JSONL";
    return `| \`${type}\` | ${owner} | ${persistence} |`;
  }).join("\n");
  return generatedHeader("Runtime event catalog") + `\nRuntime JSONL is the source of truth; metrics, AgentMemory, trajectory UI, and OTLP are projections/consumers.\n\n| Event | Producer | Persistence |\n| --- | --- | --- |\n${rows}\n`;
}

function renderProviderCatalog() {
  const capabilities = Object.entries(CODEX_RUNNER_CAPABILITIES)
    .map(([key, value]) => `| \`${key}\` | ${Array.isArray(value) ? value.map((item) => `\`${item}\``).join(", ") : String(value)} |`)
    .join("\n");
  return generatedHeader("Agent provider catalog") + `\n## \`codex\`\n\nDefault delegated coding runner. Provider credentials and routing remain server-side and are deliberately excluded from this generated document.\n\n| Capability | Value |\n| --- | --- |\n${capabilities}\n`;
}

function renderRuntimeGraph() {
  return generatedHeader("Runtime graph") + `\n\`\`\`mermaid\ngraph TD\n  ChatGPT[ChatGPT / MCP client] --> Compact[20 compact facades]\n  Compact --> Pipeline[ActionExecutionPipeline]\n  Pipeline --> Backend[Hidden backend actions]\n  Pipeline --> Events[RuntimeEventStore JSONL]\n  Pipeline --> Metrics[ToolMetrics]\n  Pipeline --> Memory[AgentMemory consumer]\n  Pipeline --> OTEL[OTLP exporter optional]\n  Events --> Trace[Trajectory query + lca_input]\n  Backend --> Agent[AgentRunnerRegistry]\n  Agent --> Codex[Codex provider]\n  Agent --> Worktree[Isolated worktree + conflict merge]\n  Backend --> UI[Browser + ADB]\n  Backend --> Integrations[Figma / Penpot / Coolify]\n  Backend --> Protected[DBeaver / Bruno / Notion protected semantics]\n\`\`\`\n\n### Invariants\n\n- LCA is trusted-local: capability is allowed by default; validation protects correctness, not permission ceremony.\n- DBeaver, Bruno, and Notion preserve their integration-specific protection semantics.\n- Project roots are discovery/default-routing inputs, not authorization boundaries.\n- Runtime JSONL is authoritative for trajectory/recovery; OTLP is an optional external projection.\n- Writable delegates default to full-access execution inside isolated worktrees; merge remains conflict-checked.\n`;
}

function generatedHeader(title) {
  return `<!-- GENERATED by server/scripts/generate-architecture-catalogs.mjs. DO NOT EDIT BY HAND. -->\n# ${title}\n`;
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function escapeMarkdown(value) {
  return String(value).trim();
}
