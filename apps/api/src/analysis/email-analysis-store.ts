import {
  EmailAnalysisServiceResponseSchema,
  EmailAnalysisSchemaVersion,
  StoredEmailAnalysisSchema,
  type EmailAnalysisServiceResponse,
  type StoredEmailAnalysis
} from "@mailpilot/shared";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { ApiError } from "../errors.js";

export interface AnalyzableEmail {
  id: string;
  userId: string;
  sourceRevision: number;
  subject: string;
  senderName: string | null;
  senderEmailNormalized: string | null;
  receivedAt: Date;
  bodyText: string;
}

export interface EmailAnalysisStore {
  findEmailRevision(userId: string, emailId: string): Promise<{ id: string; sourceRevision: number } | null>;
  findEmailForAnalysis(userId: string, emailId: string): Promise<AnalyzableEmail | null>;
  findCompletedAnalysis(
    userId: string,
    emailId: string,
    sourceRevision: number
  ): Promise<StoredEmailAnalysis | null>;
  saveAnalysis(result: EmailAnalysisServiceResponse): Promise<StoredEmailAnalysis>;
}

export class PrismaEmailAnalysisStore implements EmailAnalysisStore {
  public constructor(private readonly database: PrismaClient) {}

  public async findEmailRevision(
    userId: string,
    emailId: string
  ): Promise<{ id: string; sourceRevision: number } | null> {
    return this.database.email.findFirst({
      where: { id: emailId, userId, deletedAt: null },
      select: { id: true, sourceRevision: true }
    });
  }

  public async findEmailForAnalysis(
    userId: string,
    emailId: string
  ): Promise<AnalyzableEmail | null> {
    return this.database.email.findFirst({
      where: { id: emailId, userId, deletedAt: null },
      select: {
        id: true,
        userId: true,
        sourceRevision: true,
        subject: true,
        senderName: true,
        senderEmailNormalized: true,
        receivedAt: true,
        bodyText: true
      }
    });
  }

  public async findCompletedAnalysis(
    userId: string,
    emailId: string,
    sourceRevision: number
  ): Promise<StoredEmailAnalysis | null> {
    const record = await this.database.analysis.findFirst({
      where: {
        userId,
        emailId,
        sourceRevision,
        schemaVersion: EmailAnalysisSchemaVersion,
        status: "completed"
      },
      orderBy: { completedAt: "desc" },
      select: {
        id: true,
        emailId: true,
        sourceRevision: true,
        schemaVersion: true,
        modelVersion: true,
        result: true,
        createdAt: true
      }
    });
    if (!record) return null;

    const serviceResult = EmailAnalysisServiceResponseSchema.safeParse(record.result);
    if (
      !serviceResult.success
      || serviceResult.data.emailId !== emailId
      || serviceResult.data.userId !== userId
      || serviceResult.data.sourceRevision !== sourceRevision
      || serviceResult.data.schemaVersion !== record.schemaVersion
      || serviceResult.data.modelVersion !== record.modelVersion
    ) {
      throw new ApiError(500, "ANALYSIS_STORAGE_INVALID", "Stored email analysis could not be read");
    }

    return toStoredAnalysis(record, serviceResult.data);
  }

  public async saveAnalysis(result: EmailAnalysisServiceResponse): Promise<StoredEmailAnalysis> {
    const record = await this.database.$transaction(async (transaction) => {
      const source = await transaction.email.findFirst({
        where: {
          id: result.emailId,
          userId: result.userId,
          sourceRevision: result.sourceRevision,
          deletedAt: null
        },
        select: { id: true }
      });
      if (!source) {
        throw new ApiError(
          409,
          "EMAIL_CHANGED_DURING_ANALYSIS",
          "The source email changed while analysis was running"
        );
      }

      return transaction.analysis.upsert({
        where: {
          emailId_sourceRevision_schemaVersion_modelVersion: {
            emailId: result.emailId,
            sourceRevision: result.sourceRevision,
            schemaVersion: result.schemaVersion,
            modelVersion: result.modelVersion
          },
          userId: result.userId
        },
        create: {
          userId: result.userId,
          emailId: result.emailId,
          sourceRevision: result.sourceRevision,
          schemaVersion: result.schemaVersion,
          modelVersion: result.modelVersion,
          status: "completed",
          result: result as unknown as Prisma.InputJsonValue,
          completedAt: new Date()
        },
        update: {
          status: "completed",
          result: result as unknown as Prisma.InputJsonValue,
          safeErrorCode: null,
          completedAt: new Date()
        },
        select: {
          id: true,
          emailId: true,
          sourceRevision: true,
          schemaVersion: true,
          modelVersion: true,
          createdAt: true
        }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return toStoredAnalysis(record, result);
  }
}

type AnalysisRecord = {
  id: string;
  emailId: string;
  sourceRevision: number;
  schemaVersion: string;
  modelVersion: string;
  createdAt: Date;
};

function toStoredAnalysis(
  record: AnalysisRecord,
  result: EmailAnalysisServiceResponse
): StoredEmailAnalysis {
  return StoredEmailAnalysisSchema.parse({
    id: record.id,
    emailId: record.emailId,
    sourceRevision: record.sourceRevision,
    schemaVersion: record.schemaVersion,
    modelVersion: record.modelVersion,
    provider: result.provider,
    responseId: result.responseId,
    providerRequestId: result.providerRequestId,
    usage: result.usage,
    analysis: result.analysis,
    createdAt: record.createdAt.toISOString()
  });
}
