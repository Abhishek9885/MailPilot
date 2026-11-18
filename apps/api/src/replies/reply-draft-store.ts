import {
  StoredReplyDraftSchema,
  type ReplyDraftMessage,
  type ReplyDraftServiceResponse,
  type StoredReplyDraft
} from "@mailpilot/shared";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { ApiError } from "../errors.js";

export interface ReplyThreadEmail extends ReplyDraftMessage {
  userId: string;
  googleConnectionId: string;
  providerThreadId: string;
}

export interface ReplyDraftStore {
  findThreadForReply(userId: string, emailId: string): Promise<ReplyThreadEmail[] | null>;
  listSuggestions(userId: string, emailId: string): Promise<StoredReplyDraft[] | null>;
  saveSuggestion(result: ReplyDraftServiceResponse): Promise<StoredReplyDraft>;
  updateSuggestion(
    userId: string,
    emailId: string,
    draftId: string,
    subject: string | undefined,
    bodyText: string
  ): Promise<StoredReplyDraft | null>;
}

export class PrismaReplyDraftStore implements ReplyDraftStore {
  public constructor(private readonly database: PrismaClient) {}

  public async findThreadForReply(userId: string, emailId: string): Promise<ReplyThreadEmail[] | null> {
    const target = await this.database.email.findFirst({
      where: { id: emailId, userId, deletedAt: null },
      select: {
        id: true,
        userId: true,
        googleConnectionId: true,
        providerThreadId: true,
        sourceRevision: true,
        subject: true,
        senderName: true,
        senderEmailNormalized: true,
        receivedAt: true,
        bodyText: true
      }
    });
    if (!target) return null;

    const earlierAndLater = await this.database.email.findMany({
      where: {
        userId,
        googleConnectionId: target.googleConnectionId,
        providerThreadId: target.providerThreadId,
        id: { not: target.id },
        deletedAt: null
      },
      orderBy: [{ receivedAt: "desc" }, { id: "asc" }],
      take: 7,
      select: {
        id: true,
        userId: true,
        googleConnectionId: true,
        providerThreadId: true,
        sourceRevision: true,
        subject: true,
        senderName: true,
        senderEmailNormalized: true,
        receivedAt: true,
        bodyText: true
      }
    });
    return [target, ...earlierAndLater].sort((left, right) =>
      left.receivedAt.getTime() - right.receivedAt.getTime()
    ).map((message) => ({
      id: message.id,
      userId: message.userId,
      googleConnectionId: message.googleConnectionId,
      providerThreadId: message.providerThreadId,
      sourceRevision: message.sourceRevision,
      subject: message.subject,
      senderName: message.senderName,
      senderEmail: message.senderEmailNormalized,
      receivedAt: message.receivedAt.toISOString(),
      bodyText: message.bodyText
    }));
  }

  public async saveSuggestion(result: ReplyDraftServiceResponse): Promise<StoredReplyDraft> {
    const record = await this.database.$transaction(async (transaction) => {
      const sourceMessages = await transaction.email.findMany({
        where: {
          userId: result.userId,
          id: { in: result.sourceMessages.map((message) => message.id) },
          deletedAt: null
        },
        select: { id: true, sourceRevision: true }
      });
      if (!sameSourceMessages(sourceMessages, result.sourceMessages)) {
        throw changedSourceError();
      }

      const target = sourceMessages.find((message) => message.id === result.emailId);
      if (!target || target.sourceRevision !== result.sourceRevision) throw changedSourceError();

      return transaction.replyDraft.create({
        data: {
          userId: result.userId,
          emailId: result.emailId,
          sourceRevision: result.sourceRevision,
          schemaVersion: result.schemaVersion,
          provider: result.provider ?? "",
          modelVersion: result.modelVersion ?? "",
          subject: result.draft.subject,
          bodyText: result.draft.bodyText,
          claims: result.draft.claims as unknown as Prisma.InputJsonValue,
          uncertainties: result.draft.uncertainties as unknown as Prisma.InputJsonValue,
          sourceMessages: result.sourceMessages as unknown as Prisma.InputJsonValue,
          status: "suggestion",
          edited: false
        },
        select: replyDraftSelect
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return toStoredDraft(record);
  }

  public async listSuggestions(userId: string, emailId: string): Promise<StoredReplyDraft[] | null> {
    const email = await this.database.email.findFirst({
      where: { id: emailId, userId, deletedAt: null },
      select: { id: true }
    });
    if (!email) return null;
    const records = await this.database.replyDraft.findMany({
      where: { userId, emailId, status: "suggestion" },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: replyDraftSelect
    });
    return records.map(toStoredDraft);
  }

  public async updateSuggestion(
    userId: string,
    emailId: string,
    draftId: string,
    subject: string | undefined,
    bodyText: string
  ): Promise<StoredReplyDraft | null> {
    const record = await this.database.$transaction(async (transaction) => {
      const existing = await transaction.replyDraft.findFirst({
        where: { id: draftId, userId, emailId, status: "suggestion" },
        select: replyDraftSelect
      });
      if (!existing) return null;
      const stored = toStoredDraft(existing);
      const currentEmail = await transaction.email.findFirst({
        where: { id: emailId, userId, deletedAt: null },
        select: { sourceRevision: true }
      });
      if (!currentEmail || currentEmail.sourceRevision !== existing.sourceRevision) {
        throw changedSourceError();
      }
      const updatedClaims = stored.claims.filter((claim) =>
        normalize(bodyText).includes(normalize(claim.claim))
      );
      const editNotice = "Evidence references may not cover statements added during manual edits.";
      const uncertainties = stored.uncertainties.includes(editNotice)
        ? stored.uncertainties
        : [...stored.uncertainties.slice(0, 9), editNotice];
      return transaction.replyDraft.update({
        where: { id: existing.id },
        data: {
          ...(subject === undefined ? {} : { subject }),
          bodyText,
          claims: updatedClaims as unknown as Prisma.InputJsonValue,
          uncertainties: uncertainties as unknown as Prisma.InputJsonValue,
          edited: true
        },
        select: replyDraftSelect
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return record === null ? null : toStoredDraft(record);
  }
}

const replyDraftSelect = {
  id: true,
  emailId: true,
  sourceRevision: true,
  schemaVersion: true,
  provider: true,
  modelVersion: true,
  subject: true,
  bodyText: true,
  claims: true,
  uncertainties: true,
  sourceMessages: true,
  status: true,
  edited: true,
  createdAt: true,
  updatedAt: true
} as const;

type ReplyDraftRecord = {
  id: string;
  emailId: string;
  sourceRevision: number;
  schemaVersion: string;
  provider: string;
  modelVersion: string;
  subject: string;
  bodyText: string;
  claims: Prisma.JsonValue;
  uncertainties: Prisma.JsonValue;
  sourceMessages: Prisma.JsonValue;
  status: "suggestion" | "dismissed";
  edited: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function sameSourceMessages(
  found: Array<{ id: string; sourceRevision: number }>,
  expected: Array<{ id: string; sourceRevision: number }>
): boolean {
  if (found.length !== expected.length) return false;
  return expected.every((source) =>
    found.some((candidate) => candidate.id === source.id && candidate.sourceRevision === source.sourceRevision)
  );
}

function changedSourceError(): ApiError {
  return new ApiError(409, "REPLY_DRAFT_SOURCE_CHANGED", "The email thread changed while the draft was being generated");
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function toStoredDraft(record: ReplyDraftRecord): StoredReplyDraft {
  return StoredReplyDraftSchema.parse({
    ...record,
    schemaVersion: record.schemaVersion,
    claims: record.claims,
    uncertainties: record.uncertainties,
    sourceMessages: record.sourceMessages,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString()
  });
}
