import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAuthStore } from "../src/auth/prisma-store.js";

describe("Prisma authentication data access", () => {
  it("scopes session revocation by both session ID and authenticated owner", async () => {
    const sessionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const database = {
      session: { updateMany: sessionUpdateMany }
    } as unknown as PrismaClient;
    const store = new PrismaAuthStore(database);
    const sessionId = "a3e93638-72b3-4bc7-9f78-2676f19a1144";
    const userId = "106320c9-d216-48ee-9264-871317387e56";
    const revokedAt = new Date("2026-10-28T12:00:00.000Z");

    await store.revokeSession(sessionId, userId, revokedAt);

    expect(sessionUpdateMany).toHaveBeenCalledWith({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt }
    });
  });

  it("scopes identity updates by the owning user as well as the identity ID", async () => {
    const userId = "106320c9-d216-48ee-9264-871317387e56";
    const identityId = "a3e93638-72b3-4bc7-9f78-2676f19a1144";
    const identityFindUnique = vi.fn().mockResolvedValue({
      id: identityId,
      userId,
      emailNormalized: "person@gmail.com",
      user: { id: userId, emailNormalized: "person@gmail.com", status: "active" }
    });
    const identityUpdate = vi.fn().mockResolvedValue(undefined);
    const database = {
      authenticationIdentity: { findUnique: identityFindUnique, update: identityUpdate }
    } as unknown as PrismaClient;
    const store = new PrismaAuthStore(database);
    const authenticatedAt = new Date("2026-10-28T12:00:00.000Z");

    await store.authenticateGoogleIdentity({
      subject: "verified-google-subject",
      email: "person@gmail.com",
      emailVerified: true
    }, authenticatedAt);

    expect(identityUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: identityId, userId }
    }));
  });
});
