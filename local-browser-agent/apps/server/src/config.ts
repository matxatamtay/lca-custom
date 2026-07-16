import os from "node:os";
import path from "node:path";

export const VERSION = "0.3.0";
export const HOST = "127.0.0.1";
export const PORT = boundedNumber(process.env.LBA_PORT, 8790, 1024, 65535);
export const MCP_AUTH_TOKEN = process.env.LBA_MCP_AUTH_TOKEN || "";
export const DATA_DIR = path.resolve(
  process.env.LBA_DATA_DIR || path.join(os.homedir(), ".local-browser-agent")
);
export const CAPTURE_DIR = path.join(DATA_DIR, "captures");
export const AUDIT_PATH = path.join(DATA_DIR, "audit.log");
export const PAIRING_PATH = path.join(DATA_DIR, "pairing.json");
export const PAIRING_TTL_MS = boundedNumber(process.env.LBA_PAIRING_TTL_MS, 10 * 60_000, 60_000, 60 * 60_000);
export const SESSION_TTL_MS = boundedNumber(process.env.LBA_SESSION_TTL_MS, 24 * 60 * 60_000, 5 * 60_000, 30 * 24 * 60 * 60_000);
export const CAPTURE_TTL_MS = boundedNumber(process.env.LBA_CAPTURE_TTL_MS, 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000);
export const MAX_BODY_BYTES = boundedNumber(process.env.LBA_MAX_BODY_BYTES, 16 * 1024 * 1024, 1024, 64 * 1024 * 1024);
export const MAX_BRIDGE_PAYLOAD_BYTES = boundedNumber(process.env.LBA_MAX_BRIDGE_PAYLOAD_BYTES, 64 * 1024 * 1024, 1024, 256 * 1024 * 1024);
export const MAX_CAPTURE_BYTES = boundedNumber(process.env.LBA_MAX_CAPTURE_BYTES, 64 * 1024 * 1024, 1024 * 1024, 512 * 1024 * 1024);
export const COMMAND_TIMEOUT_MS = boundedNumber(process.env.LBA_COMMAND_TIMEOUT_MS, 45_000, 1_000, 10 * 60_000);

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
