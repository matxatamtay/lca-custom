import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { AUDIT_PATH } from "../config.js";
import { redactDeep } from "./redaction.js";

export async function audit(event: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(path.dirname(AUDIT_PATH), { recursive: true });
    const safe = redactDeep({ ts: new Date().toISOString(), ...event });
    await appendFile(AUDIT_PATH, `${JSON.stringify(safe)}\n`, "utf8");
  } catch {
    // Audit failure must not crash the bridge.
  }
}
