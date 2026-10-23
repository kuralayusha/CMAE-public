import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import fs from "node:fs";
import path from "node:path";
import { getAppRoot } from "@/lib/paths";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Desktop and `desktop:dev` store the key that encrypted this data directory
 * in `<appRoot>/master.key`. `next dev` still loads a different
 * `CMAE_MASTER_KEY` from `.env`, while `~/.cmae-app-root` points the process
 * at that same directory. Prefer the file so both entrypoints open one DB.
 */
function keyFromDataDir(): string | null {
  try {
    const file = path.join(/*turbopackIgnore: true*/ getAppRoot(), "master.key");
    if (!fs.existsSync(/*turbopackIgnore: true*/ file)) return null;
    const key = fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8").trim();
    return key.length >= 16 ? key : null;
  } catch {
    return null;
  }
}

function getMasterKey(): Buffer {
  const raw = keyFromDataDir() || process.env.CMAE_MASTER_KEY;
  if (!raw || raw.length < 16) {
    throw new Error(
      "CMAE_MASTER_KEY is missing or too short. Add a key of at least 16 characters to .env.",
    );
  }
  return createHash("sha256").update(raw).digest();
}

/** AES-256-GCM: iv(12) + tag(16) + ciphertext → base64 */
export function encrypt(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decrypt(payload: string): string {
  const key = getMasterKey();
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("Invalid encrypted data");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function encryptOptional(value: string | null | undefined): string | null {
  if (!value) return null;
  return encrypt(value);
}

export function decryptOptional(value: string | null | undefined): string | null {
  if (!value) return null;
  return decrypt(value);
}
