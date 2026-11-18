import { z } from "zod";
import {
  EmailAnalysisSchemaVersion,
  type StoredEmailAnalysis
} from "@mailpilot/shared";
import { ApiError } from "../errors.js";
import type { EmailAnalysisClient } from "./email-analysis-client.js";
import type { EmailAnalysisStore } from "./email-analysis-store.js";

const EmailIdSchema = z.uuid();
const MAX_ANALYSIS_EMAIL_CHARS = 100_000;

export class EmailAnalysisService {
  public constructor(
    private readonly store: EmailAnalysisStore,
    private readonly analyzer: EmailAnalysisClient
  ) {}

  public async get(userId: string, untrustedEmailId: string): Promise<StoredEmailAnalysis | null> {
    const emailId = EmailIdSchema.safeParse(untrustedEmailId);
    if (!emailId.success) {
      throw new ApiError(404, "EMAIL_NOT_FOUND", "Email was not found");
    }
    const email = await this.store.findEmailRevision(userId, emailId.data);
    if (!email) throw new ApiError(404, "EMAIL_NOT_FOUND", "Email was not found");
    return this.store.findCompletedAnalysis(userId, email.id, email.sourceRevision);
  }

  public async analyze(
    userId: string,
    untrustedEmailId: string,
    options: { reanalyze?: boolean } = {}
  ): Promise<StoredEmailAnalysis> {
    const emailId = EmailIdSchema.safeParse(untrustedEmailId);
    if (!emailId.success) {
      throw new ApiError(404, "EMAIL_NOT_FOUND", "Email was not found");
    }

    const email = await this.store.findEmailForAnalysis(userId, emailId.data);
    if (!email) throw new ApiError(404, "EMAIL_NOT_FOUND", "Email was not found");
    if (email.bodyText.length > MAX_ANALYSIS_EMAIL_CHARS) {
      throw new ApiError(413, "EMAIL_TOO_LARGE_TO_ANALYZE", "Email exceeds the analysis size limit");
    }

    if (!options.reanalyze) {
      const existing = await this.store.findCompletedAnalysis(
        userId,
        email.id,
        email.sourceRevision
      );
      if (existing) return existing;
    }

    const result = await this.analyzer.analyze({
      userId,
      emailId: email.id,
      sourceRevision: email.sourceRevision,
      subject: email.subject,
      senderName: email.senderName,
      senderEmail: email.senderEmailNormalized,
      receivedAt: email.receivedAt,
      bodyText: email.bodyText
    });
    if (
      result.userId !== userId
      || result.emailId !== email.id
      || result.sourceRevision !== email.sourceRevision
      || result.schemaVersion !== EmailAnalysisSchemaVersion
    ) {
      throw new ApiError(502, "AI_RESPONSE_INVALID", "Email analysis returned an invalid response");
    }

    return this.store.saveAnalysis(result);
  }
}
