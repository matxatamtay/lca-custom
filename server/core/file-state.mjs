import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function detectTextMetadata(raw) {
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const text = raw.toString("utf8");
  const body = bom && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let eol = null;
  if (body.includes("\r\n")) eol = "crlf";
  else if (body.includes("\n")) eol = "lf";
  const finalNewline = body.endsWith("\r\n") || body.endsWith("\n");
  return { bom, eol, finalNewline, text: body };
}

export async function readPathState(filePath) {
  try {
    const info = await lstat(filePath);
    if (!info.isFile()) {
      return {
        path: filePath,
        exists: true,
        kind: info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "other",
        size: info.size,
        mtimeMs: info.mtimeMs,
        sha256: null,
        bom: false,
        eol: null,
        finalNewline: false,
        text: null
      };
    }
    const raw = await readFile(filePath);
    const metadata = detectTextMetadata(raw);
    return {
      path: filePath,
      exists: true,
      kind: "file",
      size: info.size,
      mtimeMs: info.mtimeMs,
      sha256: sha256(raw),
      ...metadata
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        path: filePath,
        exists: false,
        kind: "missing",
        size: 0,
        mtimeMs: null,
        sha256: null,
        bom: false,
        eol: null,
        finalNewline: false,
        text: null
      };
    }
    throw error;
  }
}

export function hashBytes(value) {
  return sha256(Buffer.isBuffer(value) ? value : Buffer.from(value));
}

export function assertExpectedHash(state, expectedHash, label = state?.path || "file") {
  if (!expectedHash) return;
  const expected = String(expectedHash).trim().toLowerCase();
  const actual = state?.sha256 ? String(state.sha256).toLowerCase() : null;
  if (actual === expected) return;
  throw new Error(`STALE_FILE: ${label} changed since it was read; expected ${expected}, actual ${actual || "<missing>"}`);
}

export function encodeTextLikeState(text, state) {
  let body = String(text);
  if (state?.eol === "crlf") body = body.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  else if (state?.eol === "lf") body = body.replace(/\r\n/g, "\n");
  const encoded = Buffer.from(body, "utf8");
  return state?.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded]) : encoded;
}

export async function writeFileAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.lca-tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(tempPath, value);
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}
