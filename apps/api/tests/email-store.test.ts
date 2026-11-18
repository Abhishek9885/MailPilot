import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaEmailStore } from "../src/emails/email-store.js";
import type { GmailMessage } from "../src/gmail/api-types.js";

const userId = "b269e8b0-dcbd-4cf6-8a30-03fb22000380";
const googleConnectionId = "97cbbe26-49c8-4cc1-aa0c-9c2cc0a6ab45";

function fakeMessage(body: string): GmailMessage {
  return {
    id: "gmail-message-1",
    threadId: "gmail-thread-1",
    labelIds: ["INBOX"],
    internalDate: "1793232000000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Sender <sender@example.test>" },
        { name: "Subject", value: "Stored subject" }
      ],
      body: { data: Buffer.from(body).toString("base64url"), size: body.length }
    }
  };
}

function createStoreMocks() {
  const transaction = {
    googleConnection: { findFirst: vi.fn().mockResolvedValue({ id: googleConnectionId }) },
    email: { findUnique: vi.fn(), upsert: vi.fn() }
  };
  const $transaction = vi.fn(async (
    operation: (transaction: Prisma.TransactionClient) => Promise<unknown>
  ) => operation(transaction as unknown as Prisma.TransactionClient));
  const database = { $transaction } as unknown as PrismaClient;
  return { database, transaction, $transaction };
}

describe("Prisma email store", () => {
  it("upserts tenant-scoped messages with sanitized content and attachment metadata", async () => {
    const { database, transaction, $transaction } = createStoreMocks();
    transaction.email.findUnique.mockResolvedValue(null);
    transaction.email.upsert.mockResolvedValue({
      id: "stored-email-1",
      providerMessageId: "gmail-message-1",
      providerThreadId: "gmail-thread-1",
      sourceRevision: 1
    });

    const store = new PrismaEmailStore(database);
    const result = await store.upsertGmailMessage(userId, googleConnectionId, fakeMessage("A message body."));

    expect(transaction.googleConnection.findFirst).toHaveBeenCalledWith({
      where: { id: googleConnectionId, userId, status: "active" },
      select: { id: true }
    });
    expect(transaction.email.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        googleConnectionId_providerMessageId: {
          googleConnectionId,
          providerMessageId: "gmail-message-1"
        }
      },
      create: expect.objectContaining({
        userId,
        googleConnectionId,
        providerMessageId: "gmail-message-1",
        sourceRevision: 1,
        attachmentMetadata: []
      })
    }));
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
    expect(result).toEqual({
      id: "stored-email-1",
      providerMessageId: "gmail-message-1",
      providerThreadId: "gmail-thread-1",
      sourceRevision: 1
    });
  });

  it("keeps source revisions stable for identical retries and increments them for content changes", async () => {
    const { database, transaction } = createStoreMocks();
    const existingHash = createHash("sha256")
      .update(JSON.stringify({ subject: "Stored subject", bodyText: "A message body.", bodyHtml: null }), "utf8")
      .digest("hex");
    transaction.email.findUnique
      .mockResolvedValueOnce({ bodyHash: existingHash, sourceRevision: 4, deletedAt: null })
      .mockResolvedValueOnce({ bodyHash: existingHash, sourceRevision: 4, deletedAt: null })
      .mockResolvedValueOnce({ bodyHash: "different-hash", sourceRevision: 4, deletedAt: null });
    transaction.email.upsert.mockResolvedValue({
      id: "stored-email-1",
      providerMessageId: "gmail-message-1",
      providerThreadId: "gmail-thread-1",
      sourceRevision: 4
    });

    const store = new PrismaEmailStore(database);
    await store.upsertGmailMessage(userId, googleConnectionId, fakeMessage("A message body."));
    await store.upsertGmailMessage(userId, googleConnectionId, fakeMessage("A message body."));
    await store.upsertGmailMessage(userId, googleConnectionId, fakeMessage("Revised body."));

    expect(transaction.email.upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
      update: expect.objectContaining({ sourceRevision: 4 })
    }));
    expect(transaction.email.upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({
      update: expect.objectContaining({ sourceRevision: 4 })
    }));
    expect(transaction.email.upsert).toHaveBeenNthCalledWith(3, expect.objectContaining({
      update: expect.objectContaining({ sourceRevision: 5 })
    }));
  });

  it("refuses a connection not owned by the supplied user before reading or writing email data", async () => {
    const { database, transaction } = createStoreMocks();
    transaction.googleConnection.findFirst.mockResolvedValue(null);

    const store = new PrismaEmailStore(database);
    await expect(
      store.upsertGmailMessage("other-user-id", googleConnectionId, fakeMessage("A message body."))
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "GMAIL_CONNECTION_NOT_FOUND"
    });
    expect(transaction.email.findUnique).not.toHaveBeenCalled();
    expect(transaction.email.upsert).not.toHaveBeenCalled();
  });
});
