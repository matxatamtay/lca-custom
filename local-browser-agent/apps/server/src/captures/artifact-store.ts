import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CAPTURE_DIR, CAPTURE_TTL_MS, MAX_CAPTURE_BYTES } from "../config.js";
import { redactHtmlMarkup } from "../security/html-redaction.js";
import { redactDeep } from "../security/redaction.js";
import type { CapturePayload } from "../../../../packages/protocol/src/index.js";

const ID_PATTERN = /^cap_[0-9a-f-]{36}$/i;
const ARTIFACT_PATTERN = /^[a-z][a-z0-9_-]*\.(json|html|png|jpe?g|webp)$/i;

export interface ArtifactDescriptor {
  name: string;
  mediaType: string;
  bytes: number;
  uri: string;
}

export interface StoredCapture {
  captureId: string;
  createdAt: string;
  expiresAt: string;
  tab: CapturePayload["tab"];
  mode: CapturePayload["mode"];
  warnings: string[];
  coverage: Record<string, unknown>;
  artifacts: ArtifactDescriptor[];
}

export class ArtifactStore {
  constructor(
    readonly captureDir = CAPTURE_DIR,
    readonly maxCaptureBytes = MAX_CAPTURE_BYTES,
    readonly captureTtlMs = CAPTURE_TTL_MS
  ) {}

  async init(): Promise<void> {
    await mkdir(this.captureDir, { recursive: true });
    await this.cleanupExpired();
  }

  async save(payload: CapturePayload, redact: boolean): Promise<StoredCapture> {
    const captureId = `cap_${randomUUID()}`;
    const capturePath = this.#capturePath(captureId);
    await mkdir(capturePath, { recursive: false });
    try {
      const artifacts: ArtifactDescriptor[] = [];
      let totalBytes = 0;

      const addJson = async (name: string, value: unknown): Promise<void> => {
        if (value === undefined) return;
        const body = `${JSON.stringify(redact ? redactDeep(value) : value)}\n`;
        totalBytes += Buffer.byteLength(body);
        this.#assertSize(totalBytes);
        const file = `${name}.json`;
        await writeFile(path.join(capturePath, file), body, "utf8");
        artifacts.push({ name: file, mediaType: "application/json", bytes: Buffer.byteLength(body), uri: this.uri(captureId, file) });
      };

      const addText = async (file: string, value: string, mediaType: string): Promise<void> => {
        const safeValue = redact
          ? (mediaType === "text/html" ? redactHtmlMarkup(value) : String(redactDeep(value)))
          : value;
        totalBytes += Buffer.byteLength(safeValue);
        this.#assertSize(totalBytes);
        await writeFile(path.join(capturePath, file), safeValue, "utf8");
        artifacts.push({ name: file, mediaType, bytes: Buffer.byteLength(safeValue), uri: this.uri(captureId, file) });
      };

      if (payload.screenshot) {
        const binary = Buffer.from(payload.screenshot.dataBase64, "base64");
        totalBytes += binary.length;
        this.#assertSize(totalBytes);
        const extension = payload.screenshot.mimeType === "image/jpeg" ? "jpg" : payload.screenshot.mimeType.split("/")[1];
        const file = `screenshot.${extension}`;
        await writeFile(path.join(capturePath, file), binary);
        artifacts.push({ name: file, mediaType: payload.screenshot.mimeType, bytes: binary.length, uri: this.uri(captureId, file) });
      }

      if (payload.html) {
        await addText("page.html", payload.html.markup, "text/html");
        const { markup: _markup, ...htmlMetadata } = payload.html;
        await addJson("html", htmlMetadata);
      }

      await addJson("dom", payload.dom);
      await addJson("console", payload.console);
      await addJson("network", payload.network);
      await addJson("performance", payload.performance);
      await addJson("accessibility", payload.accessibility);
      await addJson("devtools", payload.devtools);
      await addJson("visual", payload.visual);

      const now = Date.now();
      const stored: StoredCapture = {
        captureId,
        createdAt: payload.capturedAt,
        expiresAt: new Date(now + this.captureTtlMs).toISOString(),
        tab: redact ? (redactDeep(payload.tab) as CapturePayload["tab"]) : payload.tab,
        mode: payload.mode,
        warnings: payload.warnings,
        coverage: redact ? (redactDeep(payload.coverage) as Record<string, unknown>) : payload.coverage,
        artifacts
      };
      await writeFile(path.join(capturePath, "manifest.json"), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
      return stored;
    } catch (error) {
      await rm(capturePath, { recursive: true, force: true });
      throw error;
    }
  }

  async readManifest(captureId: string): Promise<StoredCapture> {
    const body = await readFile(path.join(this.#capturePath(captureId), "manifest.json"), "utf8");
    return JSON.parse(body) as StoredCapture;
  }

  async readArtifact(captureId: string, artifact: string): Promise<{ descriptor: ArtifactDescriptor; data: Buffer }> {
    if (!ARTIFACT_PATTERN.test(artifact)) throw new Error("Invalid artifact name.");
    const manifest = await this.readManifest(captureId);
    const descriptor = manifest.artifacts.find((candidate) => candidate.name === artifact);
    if (!descriptor) throw new Error("Artifact not found.");
    const data = await readFile(path.join(this.#capturePath(captureId), artifact));
    return { descriptor, data };
  }

  async delete(captureId: string): Promise<void> {
    await rm(this.#capturePath(captureId), { recursive: true, force: false });
  }

  async cleanupExpired(): Promise<number> {
    await mkdir(this.captureDir, { recursive: true });
    let removed = 0;
    for (const entry of await readdir(this.captureDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      const dir = path.join(this.captureDir, entry.name);
      try {
        const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as StoredCapture;
        if (Date.parse(manifest.expiresAt) <= Date.now()) {
          await rm(dir, { recursive: true, force: true });
          removed++;
        }
      } catch {
        const info = await stat(dir);
        if (Date.now() - info.mtimeMs > this.captureTtlMs) {
          await rm(dir, { recursive: true, force: true });
          removed++;
        }
      }
    }
    return removed;
  }

  uri(captureId: string, artifact: string): string {
    return `browser://capture/${captureId}/${artifact}`;
  }

  #capturePath(captureId: string): string {
    if (!ID_PATTERN.test(captureId)) throw new Error("Invalid capture id.");
    return path.join(this.captureDir, captureId);
  }

  #assertSize(bytes: number): void {
    if (bytes > this.maxCaptureBytes) throw new Error(`Capture exceeds ${this.maxCaptureBytes} bytes.`);
  }
}
