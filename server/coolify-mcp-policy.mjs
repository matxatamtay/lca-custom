// Local Coding Agent — Coolify operation policy
// SPDX-License-Identifier: AGPL-3.0-or-later

const READ_ACTIONS = new Set([
  "get",
  "get_current",
  "get_current_members",
  "get_members",
  "health",
  "list",
  "list_branches",
  "list_containers",
  "list_executions",
  "list_for_app",
  "list_images",
  "list_locations",
  "list_repos",
  "list_resources",
  "list_server_types",
  "list_ssh_keys",
  "validate"
]);

const DESTRUCTIVE_ACTIONS = new Set(["cancel", "delete", "disable_api", "stop"]);
const DESTRUCTIVE_TOOLS = new Set(["stop_all_apps"]);

export function classifyCoolifyTool(tool, args = {}) {
  const action = String(args?.action || "").trim().toLowerCase();
  const name = String(tool?.name || "").trim();
  const annotations = tool?.annotations || {};

  if (!action) {
    const actions = tool?.inputSchema?.properties?.action?.enum;
    if (Array.isArray(actions) && actions.length > 0) {
      const policies = new Set(actions.map((candidate) => classifyCoolifyTool(tool, { action: candidate })));
      return policies.size === 1 ? [...policies][0] : "mixed";
    }
  }

  if (
    DESTRUCTIVE_TOOLS.has(name)
    || DESTRUCTIVE_ACTIONS.has(action)
    || action.startsWith("delete_")
  ) return "destructive";

  if (
    annotations.readOnlyHint === true
    || READ_ACTIONS.has(action)
    || action.startsWith("get_")
    || action.startsWith("list_")
  ) return "read";

  return "mutation";
}

export function assertCoolifyPolicy(toolName, tool, args, policy, confirmed) {
  const classification = classifyCoolifyTool(tool, args);

  if (policy === "read" && classification !== "read") {
    throw new Error(`Coolify tool "${toolName}" is ${classification}; use the matching mutation or destructive action.`);
  }
  if (policy === "mutation" && classification !== "mutation") {
    throw new Error(`Coolify tool "${toolName}" is ${classification}; use the matching read or destructive action.`);
  }
  if (policy === "safe" && classification === "destructive") {
    throw new Error(`Coolify tool "${toolName}" is destructive for this action. Use coolify_destructive_tool only after the user explicitly confirms the operation.`);
  }
  if (policy !== "destructive") return classification;

  if (classification !== "destructive") {
    throw new Error(`Coolify tool "${toolName}" is ${classification}; destructive execution is not required.`);
  }
  if (confirmed !== true) {
    throw new Error("Destructive Coolify operations require confirmed=true after explicit user confirmation.");
  }
  return classification;
}

export function coolifyToolResultError(result) {
  const text = Array.isArray(result?.content)
    ? result.content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text.trim())
      .find(Boolean)
    : "";

  if (result?.isError === true) return text || "Coolify MCP tool call failed.";
  if (/^Error:\s+HTTP\s+\d+/i.test(text)) return text;
  return "";
}

export function redactKnownSecrets(message, secrets = []) {
  let redacted = String(message || "");
  const candidates = [process.env.COOLIFY_ACCESS_TOKEN, ...secrets]
    .filter((value) => typeof value === "string" && value.length > 0);

  for (const secret of candidates) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted;
}
