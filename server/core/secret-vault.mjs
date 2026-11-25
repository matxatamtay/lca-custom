import { spawn } from "node:child_process";

const SECRET_REF_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const MAX_SECRET_CHARS = 20_000;

export function createSecretVault(options = {}) {
  const promptSecret = options.promptSecret || promptSecretWithSystemUi;
  const now = options.now || (() => Date.now());
  const entries = new Map();

  function normalizeRef(ref) {
    const value = String(ref || "").trim();
    if (!SECRET_REF_RE.test(value)) {
      throw new Error("Secret ref must match [A-Za-z][A-Za-z0-9_.-]{0,79}.");
    }
    return value;
  }

  function purgeExpired() {
    const timestamp = now();
    for (const [ref, entry] of entries) {
      if (entry.expiresAt != null && entry.expiresAt <= timestamp) entries.delete(ref);
    }
  }

  async function prompt({ ref, label, ttl_ms: ttlMs } = {}) {
    const normalizedRef = normalizeRef(ref);
    const title = String(label || normalizedRef).slice(0, 200);
    const value = await promptSecret({ ref: normalizedRef, label: title });
    if (typeof value !== "string") throw new Error("Secret prompt returned an invalid value.");
    if (value.length > MAX_SECRET_CHARS) throw new Error(`Secret exceeds ${MAX_SECRET_CHARS} characters.`);
    const ttl = ttlMs == null ? null : Math.max(60_000, Math.min(24 * 60 * 60_000, Number(ttlMs) || 0));
    const createdAt = now();
    entries.set(normalizedRef, {
      value,
      createdAt,
      expiresAt: ttl == null ? null : createdAt + ttl
    });
    return {
      ok: true,
      ref: normalizedRef,
      stored: true,
      expires_at: ttl == null ? null : new Date(createdAt + ttl).toISOString()
    };
  }

  function resolve(ref) {
    purgeExpired();
    const normalizedRef = normalizeRef(ref);
    const entry = entries.get(normalizedRef);
    if (!entry) {
      throw new Error(`Secret ref '${normalizedRef}' is not loaded. Call secret_prompt first.`);
    }
    return entry.value;
  }

  function forget(ref) {
    const normalizedRef = normalizeRef(ref);
    return { ok: true, ref: normalizedRef, forgotten: entries.delete(normalizedRef) };
  }

  function status() {
    purgeExpired();
    return {
      storage: "memory-only",
      refs: [...entries.entries()].map(([ref, entry]) => ({
        ref,
        expires_at: entry.expiresAt == null ? null : new Date(entry.expiresAt).toISOString()
      }))
    };
  }

  function redactText(text, values = []) {
    let safe = String(text ?? "");
    const candidates = [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))]
      .sort((left, right) => right.length - left.length);
    for (const secret of candidates) safe = safe.split(secret).join("[redacted secret]");
    return safe;
  }

  return { forget, prompt, redactText, resolve, status };
}

async function promptSecretWithSystemUi({ label }) {
  if (process.platform !== "darwin") {
    throw new Error("secret_prompt currently requires macOS. No secret was stored.");
  }
  const script = buildMacSecretPromptScript(label);

  return await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_SECRET_CHARS + 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(/User canceled/i.test(stderr) ? "Secret prompt canceled." : "Secret prompt failed."));
        return;
      }
      resolve(stdout.replace(/\r?\n$/, ""));
    });
  });
}

export function buildMacSecretPromptScript(label) {
  const dialog = [
    'set dialogResult to display dialog "Enter secret for: ' + escapeAppleScript(label) + '"',
    'default answer "" with hidden answer',
    'buttons {"Cancel", "Save"} default button "Save" cancel button "Cancel"',
    'with title "LCA Secret Input"'
  ].join(" ");
  return `${dialog}\nreturn text returned of dialogResult`;
}

function escapeAppleScript(value) {
  return String(value || "").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
