import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { EncryptedToken } from "./types.js";

const DEFAULT_KEY_VERSION = "v1";

function resolveKeyBuffer(rawKey: string): Buffer {
  const base64Buffer = Buffer.from(rawKey, "base64");
  if (base64Buffer.length === 32 && base64Buffer.toString("base64") === rawKey) {
    return base64Buffer;
  }
  return createHash("sha256").update(rawKey).digest();
}

export function encryptRefreshToken(token: string, rawKey: string, keyVersion = DEFAULT_KEY_VERSION): EncryptedToken {
  const key = resolveKeyBuffer(rawKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]).toString("base64url");
  const authTag = cipher.getAuthTag().toString("base64url");
  const nonce = iv.toString("base64url");

  return {
    ciphertext,
    nonce,
    authTag,
    keyVersion
  };
}

export function decryptRefreshToken(encrypted: EncryptedToken, rawKey: string): string {
  const key = resolveKeyBuffer(rawKey);
  const nonce = Buffer.from(encrypted.nonce, "base64url");
  const authTag = Buffer.from(encrypted.authTag, "base64url");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64url");

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

