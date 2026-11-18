import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { ApiError } from "../errors.js";
import type { GmailMessage } from "../gmail/api-types.js";
import { parseGmailMessage } from "../gmail/email-parser.js";

const MAX_UPSERT_ATTEMPTS = 3;

export interface StoredGmailEmailReference {
  id: string;
  providerMessageId: string;
  providerThreadId: string;
  sourceRevision: number;
}

export class PrismaEmailStore {
  public constructor(private readonly database: PrismaClient) {}

  public async upsertGmailMessage(
    userId: string,
    googleConnectionId: string,
    message: GmailMessage
  ): Promise<StoredGmailEmailReference> {
    const parsed = parseGmailMessage(message);
    const bodyHash = hashContent(parsed.subject, parsed.bodyText, parsed.bodyHtml);

    for (let attempt = 1; attempt <= MAX_UPSERT_ATTEMPTS; attempt += 1) {
      try {
        return await this.database.$transaction(async (transaction) => {
          const connection = await transaction.googleConnection.findFirst({
            where: { id: googleConnectionId, userId, status: "active" },
            select: { id: true }
          });
          if (!connection) {
            throw new ApiError(404, "GMAIL_CONNECTION_NOT_FOUND", "Connected Gmail account was not found");
          }

          const where = {
            googleConnectionId_providerMessageId: {
              googleConnectionId,
              providerMessageId: parsed.providerMessageId
            }
          };
          const existing = await transaction.email.findUnique({
            where,
            select: { bodyHash: true, sourceRevision: true, deletedAt: true }
          });
          const changed = existing !== null && (existing.bodyHash !== bodyHash || existing.deletedAt !== null);
          const sourceRevision = existing
            ? existing.sourceRevision + (changed ? 1 : 0)
            : 1;
          const attachmentMetadata: Prisma.InputJsonArray = parsed.attachments.map((attachment) => ({
            partId: attachment.partId,
            attachmentId: attachment.attachmentId,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            size: attachment.size,
            disposition: attachment.disposition,
            contentId: attachment.contentId
          }));
          const emailData = {
            providerThreadId: parsed.providerThreadId,
            senderName: parsed.senderName,
            senderEmailNormalized: parsed.senderEmailNormalized,
            subject: parsed.subject,
            bodyText: parsed.bodyText,
            bodyHtml: parsed.bodyHtml,
            attachmentMetadata,
            bodyHash,
            labels: parsed.labels,
            receivedAt: parsed.receivedAt,
            sourceRevision,
            deletedAt: null
          };

          const email = await transaction.email.upsert({
            where,
            create: {
              userId,
              googleConnectionId,
              providerMessageId: parsed.providerMessageId,
              ...emailData
            },
            update: emailData,
            select: { id: true, providerMessageId: true, providerThreadId: true, sourceRevision: true }
          });

          return email;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error: unknown) {
        if (!isSerializationConflict(error) || attempt === MAX_UPSERT_ATTEMPTS) throw error;
      }
    }

    throw new Error("Gmail email upsert attempts were exhausted.");
  }

  public async markGmailMessageDeleted(
    userId: string,
    googleConnectionId: string,
    providerMessageId: string,
    deletedAt: Date
  ): Promise<void> {
    await this.database.email.updateMany({
      where: { userId, googleConnectionId, providerMessageId, deletedAt: null },
      data: { deletedAt }
    });
  }
}

function hashContent(subject: string, bodyText: string, bodyHtml: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify({ subject, bodyText, bodyHtml }), "utf8")
    .digest("hex");
}

function isSerializationConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2034";
}
