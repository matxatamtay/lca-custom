import path from "node:path";
import blessed from "neo-blessed";
import { THEME } from "./theme.mjs";

export function modalButton(parent, label, left, offset, bg) {
  const centeredLeft = typeof left === "string" && left === "center" ? `50%${offset >= 0 ? "+" : ""}${offset}` : left;
  return blessed.button({
    parent,
    bottom: 1,
    left: centeredLeft,
    width: label.length + 4,
    height: 1,
    mouse: true,
    keys: true,
    content: ` ${label} `,
    style: { bg, fg: "black", focus: { bg: THEME.accent2, fg: "black", bold: true }, hover: { bg: THEME.accent2, fg: "black" } }
  });
}

export function escapeTags(value) {
  return String(value ?? "").replaceAll("{", "\\{").replaceAll("}", "\\}");
}

export function renderData(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function fileContent(value) {
  if (typeof value === "string") return value;
  return value?.content ?? JSON.stringify(value, null, 2);
}

export function resolveAgainst(base, value) {
  const text = String(value || "");
  return path.isAbsolute(text) ? path.resolve(text) : path.resolve(base, text);
}

export function providerIcon(provider) {
  if (provider === "filesystem") return "▤";
  if (provider === "semantic") return "◇";
  if (provider === "codegraph") return "⌘";
  if (provider === "agentmemory") return "∞";
  return "·";
}

export function integrationSummary(name, settled) {
  if (settled.status === "rejected") return { name, ok: false, detail: settled.reason?.message || "offline" };
  const value = settled.value;
  return { name, ok: !isOfflineResult(value), detail: isOfflineResult(value) ? value?.error || "offline" : "connected" };
}

export function isOfflineResult(value) {
  if (!value || typeof value !== "object") return false;
  return value.connected === false || value.status === "offline" || Boolean(value.error);
}
