import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PAIRING_PATH, PAIRING_TTL_MS, SESSION_TTL_MS } from "../config.js";

interface PairingCode {
  code: string;
  expiresAt: number;
}

interface Session {
  id: string;
  extensionId: string;
  origin: string;
  tokenHash: Buffer;
  createdAt: number;
  expiresAt: number;
}

export class PairingManager {
  #pairing: PairingCode = this.#newPairingCode();
  #sessions = new Map<string, Session>();
  #attempts = new Map<string, { count: number; windowStartedAt: number; blockedUntil: number }>();
  readonly #pairingPath: string;

  constructor(pairingPath = PAIRING_PATH) {
    this.#pairingPath = pairingPath;
    this.#persistPairingCode();
  }

  currentCode(): { code: string; expiresAt: string } {
    if (Date.now() >= this.#pairing.expiresAt) {
      this.#pairing = this.#newPairingCode();
      this.#persistPairingCode();
    }
    return { code: this.#pairing.code, expiresAt: new Date(this.#pairing.expiresAt).toISOString() };
  }

  rotateCode(): { code: string; expiresAt: string } {
    this.#pairing = this.#newPairingCode();
    this.#persistPairingCode();
    return this.currentCode();
  }

  pair(code: string, extensionId: string, origin: string): { token: string; sessionId: string; expiresAt: string } {
    assertExtensionOrigin(extensionId, origin);
    this.#assertPairingAllowed(origin);
    const current = this.currentCode();
    if (!safeEqual(code, current.code)) {
      this.#recordPairingFailure(origin);
      throw new Error("Invalid or expired pairing code.");
    }
    this.#attempts.delete(origin);

    const token = randomBytes(32).toString("base64url");
    const session: Session = {
      id: randomUUID(),
      extensionId,
      origin,
      tokenHash: hashToken(token),
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS
    };
    this.#sessions.set(session.id, session);
    this.#pairing = this.#newPairingCode();
    this.#persistPairingCode();
    this.#cleanup();
    return { token, sessionId: session.id, expiresAt: new Date(session.expiresAt).toISOString() };
  }

  authenticate(token: string, extensionId: string, origin: string): { sessionId: string; expiresAt: string } | null {
    if (!token) return null;
    assertExtensionOrigin(extensionId, origin);
    this.#cleanup();
    const candidateHash = hashToken(token);
    for (const session of this.#sessions.values()) {
      if (session.extensionId !== extensionId || session.origin !== origin) continue;
      if (safeBufferEqual(candidateHash, session.tokenHash)) {
        return { sessionId: session.id, expiresAt: new Date(session.expiresAt).toISOString() };
      }
    }
    return null;
  }

  revoke(sessionId: string): boolean {
    return this.#sessions.delete(sessionId);
  }

  #newPairingCode(): PairingCode {
    return {
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      expiresAt: Date.now() + PAIRING_TTL_MS
    };
  }

  #persistPairingCode(): void {
    try {
      mkdirSync(path.dirname(this.#pairingPath), { recursive: true });
      writeFileSync(this.#pairingPath, `${JSON.stringify({ code: this.#pairing.code, expiresAt: new Date(this.#pairing.expiresAt).toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // The server still prints the code if local persistence is unavailable.
    }
  }

  #assertPairingAllowed(origin: string): void {
    const attempt = this.#attempts.get(origin);
    if (attempt?.blockedUntil && attempt.blockedUntil > Date.now()) {
      throw new Error(`Pairing is temporarily blocked until ${new Date(attempt.blockedUntil).toISOString()}.`);
    }
  }

  #recordPairingFailure(origin: string): void {
    const now = Date.now();
    const previous = this.#attempts.get(origin);
    const withinWindow = previous && now - previous.windowStartedAt < 60_000;
    const count = withinWindow ? previous.count + 1 : 1;
    this.#attempts.set(origin, {
      count,
      windowStartedAt: withinWindow ? previous.windowStartedAt : now,
      blockedUntil: count >= 5 ? now + 5 * 60_000 : 0
    });
  }

  #cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(id);
    }
    for (const [origin, attempt] of this.#attempts) {
      if (attempt.blockedUntil <= now && now - attempt.windowStartedAt >= 60_000) this.#attempts.delete(origin);
    }
  }
}

function assertExtensionOrigin(extensionId: string, origin: string): void {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error("Invalid Chromium extension id.");
  if (origin !== `chrome-extension://${extensionId}`) throw new Error("Extension id does not match WebSocket origin.");
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function safeEqual(a: string, b: string): boolean {
  return safeBufferEqual(Buffer.from(a), Buffer.from(b));
}

function safeBufferEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
