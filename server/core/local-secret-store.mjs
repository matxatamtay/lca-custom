import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REF_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;

export function createLocalSecretStore(options = {}) {
  const filePath = path.resolve(options.filePath || defaultSecretStorePath(options.root));
  const normalizeRef = (ref) => {
    const value = String(ref || "").trim();
    if (!REF_RE.test(value)) throw new Error("Invalid secret reference.");
    return value;
  };

  function readAll() {
    if (!existsSync(filePath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      throw new Error("Local secret store is unreadable.");
    }
  }

  function writeAll(data) {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, filePath);
    chmodSync(filePath, 0o600);
  }

  return {
    filePath,
    get(ref) {
      const key = normalizeRef(ref);
      const value = readAll()[key];
      return typeof value === "string" ? value : null;
    },
    set(ref, value) {
      const key = normalizeRef(ref);
      const text = String(value ?? "");
      if (!text) throw new Error("Secret cannot be empty.");
      if (text.length > 20_000) throw new Error("Secret is too large.");
      const data = readAll();
      data[key] = text;
      writeAll(data);
      return { ok: true, ref: key, storage: "local-0600" };
    },
    delete(ref) {
      const key = normalizeRef(ref);
      const data = readAll();
      const existed = Object.prototype.hasOwnProperty.call(data, key);
      if (existed) {
        delete data[key];
        writeAll(data);
      }
      return { ok: true, ref: key, deleted: existed };
    },
    has(ref) {
      return this.get(ref) !== null;
    },
    refs() {
      return Object.keys(readAll()).sort();
    }
  };
}

export function defaultSecretStorePath() {
  return path.join(os.homedir(), ".config", "lca-custom", "local-secrets.json");
}
