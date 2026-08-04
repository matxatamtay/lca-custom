// Local Coding Agent TUI — safe .env.local configuration helpers
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const SECRET_KEY_PATTERN = /(?:^|_)(?:TOKEN|ACCESS_KEY|API_KEY|SECRET|PASSWORD|PASSCODE|PRIVATE_KEY|CREDENTIALS?|COOKIE|AUTHORIZATION|DSN)(?:$|_)/i;
const SECRET_CONNECTION_PATTERN = /^(?:DATABASE|POSTGRES|POSTGRESQL|MYSQL|MARIADB|MONGODB|REDIS|AMQP|RABBITMQ)_URL$/i;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvKey(key) {
  return ENV_KEY_PATTERN.test(String(key || "").trim());
}

export function isSecretEnvKey(key) {
  const normalized = String(key || "").trim();
  return SECRET_KEY_PATTERN.test(normalized) || SECRET_CONNECTION_PATTERN.test(normalized);
}

export function parseEnvText(text) {
  const entries = [];
  const values = {};
  for (const [lineIndex, rawLine] of String(text || "").split(/\r?\n/).entries()) {
    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = parseEnvValue(match[2]);
    values[key] = value;
    entries.push({ key, value, line: lineIndex + 1, secret: isSecretEnvKey(key) });
  }
  return { entries, values };
}

export async function readEnvConfig(filePath) {
  const resolved = path.resolve(filePath);
  try {
    const text = await readFile(resolved, "utf8");
    const parsed = parseEnvText(text);
    return { path: resolved, exists: true, text, ...parsed };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { path: resolved, exists: false, text: "", entries: [], values: {} };
  }
}

export async function loadEnvFileValues(filePath) {
  return (await readEnvConfig(filePath)).values;
}

export async function updateEnvConfig(filePath, updates) {
  const config = await readEnvConfig(filePath);
  await atomicWrite(filePath, mergeEnvText(config.text, updates));
  return readEnvConfig(filePath);
}

export async function removeEnvKeys(filePath, keys) {
  const config = await readEnvConfig(filePath);
  await atomicWrite(filePath, removeKeysFromEnvText(config.text, keys));
  return readEnvConfig(filePath);
}

export function mergeEnvText(existingText, updates) {
  const normalized = Object.fromEntries(Object.entries(updates || {}).map(([key, value]) => {
    const cleanKey = String(key || "").trim();
    if (!isValidEnvKey(cleanKey)) throw new Error(`Invalid environment variable name: ${cleanKey || "(empty)"}`);
    return [cleanKey, String(value ?? "")];
  }));
  const seen = new Set();
  const lines = String(existingText || "").split(/\r?\n/);
  if (lines.length && lines.at(-1) === "") lines.pop();
  const next = lines.map((line) => {
    const match = line.match(/^(\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match || !(match[2] in normalized)) return line;
    seen.add(match[2]);
    return `${match[1]}${match[2]}${match[3]}${formatEnvValue(normalized[match[2]])}`;
  });
  for (const key of Object.keys(normalized)) {
    if (!seen.has(key)) next.push(`${key}=${formatEnvValue(normalized[key])}`);
  }
  return `${next.join("\n")}\n`;
}

export function removeKeysFromEnvText(existingText, keys) {
  const removals = new Set((keys || []).map((key) => String(key || "").trim()).filter(Boolean));
  const lines = String(existingText || "").split(/\r?\n/);
  const next = lines.filter((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !match || !removals.has(match[1]);
  });
  while (next.length && next.at(-1) === "") next.pop();
  return next.length ? `${next.join("\n")}\n` : "";
}

export function maskedEnvValue(key, value) {
  const text = String(value ?? "");
  if (!text) return "(empty)";
  if (isSecretEnvKey(key)) return "••••••";
  return text.length <= 72 ? text : `${text.slice(0, 69)}…`;
}

function parseEnvValue(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

function formatEnvValue(value) {
  const text = String(value ?? "");
  if (!/[\s"'#]/.test(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

async function atomicWrite(filePath, text) {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, resolved);
    try { await chmod(resolved, 0o600); } catch { /* Windows may ignore POSIX mode. */ }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
