import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaGmailConnectionStore } from "../src/gmail/connection-store.js";
import { encryptRefreshToken } from "../src/gmail/token-encryption.js";

describe("Prisma Gmail connection store", () => {
  const encryptionKey = "local-replace-with-base64-encoded-32-byte-key";

  it("scopes disconnect by authenticated user ID and purges token ciphertext and nonce", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const database = {
      googleConnection: { updateMany }
    } as unknown as PrismaClient;

    const store = new PrismaGmailConnectionStore(database, encryptionKey);
    const userId = "106320c9-d216-48ee-9264-871317387e56";
    const disconnectedAt = new Date("2026-10-28T12:00:00.000Z");

    await store.disconnectGmail(userId, disconnectedAt);

    expect(updateMany).toHaveBeenCalledWith({
      where: { userId, status: { not: "disconnected" } },
      data: {
        status: "disconnected",
        disconnectedAt,
        refreshTokenCiphertext: null,
        refreshTokenNonce: null,
        refreshTokenAuthTag: null,
        tokenEncryptionKeyVersion: null
      }
    });
  });

  it("decrypts stored refresh token using the configured key", async () => {
    const rawToken = "1//04test-refresh-token-secret";
    const encrypted = encryptRefreshToken(rawToken, encryptionKey);
    const userId = "106320c9-d216-48ee-9264-871317387e56";

    const findUnique = vi.fn().mockResolvedValue({
      id: "conn-1",
      userId,
      providerSubject: "sub-1",
      providerEmailNormalized: "user@gmail.com",
      status: "active",
      refreshTokenCiphertext: encrypted.ciphertext,
      refreshTokenNonce: encrypted.nonce,
      refreshTokenAuthTag: encrypted.authTag,
      tokenEncryptionKeyVersion: encrypted.keyVersion
    });
    const database = {
      googleConnection: { findUnique }
    } as unknown as PrismaClient;

    const store = new PrismaGmailConnectionStore(database, encryptionKey);
    const decrypted = await store.getDecryptedRefreshToken(userId);

    expect(findUnique).toHaveBeenCalledWith({ where: { userId } });
    expect(decrypted).toBe(rawToken);
  });
});

