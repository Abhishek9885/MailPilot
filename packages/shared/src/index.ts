import { z } from "zod";

export const ServiceHealthSchema = z.object({
  service: z.string().min(1),
  status: z.enum(["ok", "unavailable"]),
  requestId: z.string().uuid()
});

export type ServiceHealth = z.infer<typeof ServiceHealthSchema>;

export const ServiceErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().uuid(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown())
  })
});

export type ServiceError = z.infer<typeof ServiceErrorSchema>;

export const AppSessionResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    email: z.email()
  })
});

export type AppSessionResponse = z.infer<typeof AppSessionResponseSchema>;

export const GmailConnectionStatusSchema = z.enum(["active", "reauth_required", "disconnected"]);
export type GmailConnectionStatus = z.infer<typeof GmailConnectionStatusSchema>;

export const GmailConnectionDetailsSchema = z.object({
  email: z.string().email(),
  status: GmailConnectionStatusSchema,
  grantedScopes: z.array(z.string()),
  connectedAt: z.string(),
  disconnectedAt: z.string().nullable(),
  lastSuccessfulSyncAt: z.string().nullable(),
  reauthRequired: z.boolean()
});
export type GmailConnectionDetails = z.infer<typeof GmailConnectionDetailsSchema>;

export const GmailConnectionResponseSchema = z.object({
  connection: GmailConnectionDetailsSchema.nullable()
});
export type GmailConnectionResponse = z.infer<typeof GmailConnectionResponseSchema>;

export const EmailAnalysisSchemaVersion = "email-analysis-v1" as const;

export const EmailCategorySchema = z.enum([
  "work",
  "personal",
  "finance",
  "travel",
  "shopping",
  "social",
  "newsletter",
  "security",
  "other"
]);

export const EmailPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);

export const EmailActionItemSchema = z.object({
  task: z.string().min(1).max(240),
  owner: z.enum(["user", "sender", "other", "unknown"]),
  dueDate: z.iso.date().nullable(),
  evidence: z.string().min(1).max(500)
}).strict();

export const EmailDeadlineCandidateSchema = z.object({
  sourceText: z.string().min(1).max(160),
  candidateDate: z.iso.date().nullable(),
  confidence: z.number().min(0).max(1),
  evidence: z.string().min(1).max(500)
}).strict();

export const EmailCommitmentSchema = z.object({
  speaker: z.enum(["sender", "user", "third_party", "unknown"]),
  commitment: z.string().min(1).max(300),
  dueDate: z.iso.date().nullable(),
  evidence: z.string().min(1).max(500)
}).strict();

export const EmailEventCandidateSchema = z.object({
  title: z.string().min(1).max(200),
  startDate: z.iso.date().nullable(),
  startTime: z.iso.time().nullable(),
  endDate: z.iso.date().nullable(),
  endTime: z.iso.time().nullable(),
  timezone: z.string().max(64).nullable(),
  location: z.string().max(240).nullable(),
  evidence: z.string().min(1).max(500)
}).strict();

export const EmailAnalysisSchema = z.object({
  categories: z.array(EmailCategorySchema).min(1).max(4),
  priority: EmailPrioritySchema,
  summary: z.string().min(1).max(600),
  actionItems: z.array(EmailActionItemSchema).max(12),
  deadlines: z.array(EmailDeadlineCandidateSchema).max(8),
  commitments: z.array(EmailCommitmentSchema).max(8),
  eventCandidates: z.array(EmailEventCandidateSchema).max(8)
}).strict();

export const LLMUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  reasoningOutputTokens: z.number().int().nonnegative().nullable(),
  cost: z.object({
    estimatedCostUsd: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
    pricingVersion: z.string().min(1).max(64),
    basis: z.literal("configured_token_rates")
  }).strict().nullable()
}).strict();

export const EmailAnalysisServiceResponseSchema = z.object({
  userId: z.uuid(),
  emailId: z.uuid(),
  sourceRevision: z.number().int().min(1),
  schemaVersion: z.literal(EmailAnalysisSchemaVersion),
  provider: z.string().min(1).max(64),
  modelVersion: z.string().min(1).max(128),
  responseId: z.string().max(256).nullable(),
  providerRequestId: z.string().max(256).nullable(),
  usage: LLMUsageSchema.nullable(),
  analysis: EmailAnalysisSchema
}).strict();

export const StoredEmailAnalysisSchema = z.object({
  id: z.uuid(),
  emailId: z.uuid(),
  sourceRevision: z.number().int().min(1),
  schemaVersion: z.literal(EmailAnalysisSchemaVersion),
  modelVersion: z.string().min(1).max(128),
  provider: z.string().min(1).max(64),
  responseId: z.string().max(256).nullable(),
  providerRequestId: z.string().max(256).nullable(),
  usage: LLMUsageSchema.nullable(),
  analysis: EmailAnalysisSchema,
  createdAt: z.iso.datetime()
}).strict();

export const EmailAnalysisReadResponseSchema = z.object({
  analysis: StoredEmailAnalysisSchema.nullable()
}).strict();

export type EmailAnalysis = z.infer<typeof EmailAnalysisSchema>;
export type EmailAnalysisServiceResponse = z.infer<typeof EmailAnalysisServiceResponseSchema>;
export type StoredEmailAnalysis = z.infer<typeof StoredEmailAnalysisSchema>;
export type EmailAnalysisReadResponse = z.infer<typeof EmailAnalysisReadResponseSchema>;

export const SyncedEmailSummarySchema = z.object({
  id: z.uuid(),
  subject: z.string().max(2_000),
  senderName: z.string().max(320).nullable(),
  senderEmail: z.string().max(320).nullable(),
  receivedAt: z.iso.datetime(),
  labels: z.array(z.string().max(255)),
  sourceRevision: z.number().int().min(1)
}).strict();

export const SyncedEmailListResponseSchema = z.object({
  emails: z.array(SyncedEmailSummarySchema).max(50)
}).strict();

export type SyncedEmailSummary = z.infer<typeof SyncedEmailSummarySchema>;
export type SyncedEmailListResponse = z.infer<typeof SyncedEmailListResponseSchema>;

export const ReplyDraftSchemaVersion = "reply-draft-v1" as const;

export const ReplyDraftMessageSchema = z.object({
  id: z.uuid(),
  sourceRevision: z.number().int().min(1),
  subject: z.string().max(2_000),
  senderName: z.string().max(320).nullable(),
  senderEmail: z.string().max(320).nullable(),
  receivedAt: z.iso.datetime(),
  bodyText: z.string().max(30_000)
}).strict();

export const ReplyDraftServiceRequestSchema = z.object({
  userId: z.uuid(),
  emailId: z.uuid(),
  sourceRevision: z.number().int().min(1),
  instruction: z.string().max(1_000).nullable(),
  messages: z.array(ReplyDraftMessageSchema).min(1).max(8)
}).strict().superRefine((request, context) => {
  if (!request.messages.some((message) => message.id === request.emailId
    && message.sourceRevision === request.sourceRevision)) {
    context.addIssue({ code: "custom", message: "The selected email must be included in context" });
  }
});

export const ReplyDraftClaimSchema = z.object({
  claim: z.string().min(1).max(300),
  sourceMessageId: z.uuid(),
  evidenceQuote: z.string().min(1).max(500)
}).strict();

export const ReplyDraftContentSchema = z.object({
  canDraft: z.boolean(),
  subject: z.string().max(2_000),
  bodyText: z.string().max(12_000),
  claims: z.array(ReplyDraftClaimSchema).max(16),
  uncertainties: z.array(z.string().min(1).max(300)).max(10),
  missingContextReason: z.string().min(1).max(300).nullable()
}).strict().superRefine((draft, context) => {
  if (draft.canDraft && (!draft.bodyText.trim() || draft.missingContextReason !== null)) {
    context.addIssue({ code: "custom", message: "A draft requires text and cannot have a missing-context reason" });
  }
  if (!draft.canDraft && (draft.bodyText.length > 0 || draft.subject.length > 0
    || draft.claims.length > 0 || !draft.missingContextReason)) {
    context.addIssue({ code: "custom", message: "An unavailable draft must not contain generated content" });
  }
});

export const ReplyDraftSourceMessageSchema = z.object({
  id: z.uuid(),
  sourceRevision: z.number().int().min(1)
}).strict();

export const ReplyDraftServiceResponseSchema = z.object({
  userId: z.uuid(),
  emailId: z.uuid(),
  sourceRevision: z.number().int().min(1),
  schemaVersion: z.literal(ReplyDraftSchemaVersion),
  provider: z.string().min(1).max(64).nullable(),
  modelVersion: z.string().min(1).max(128).nullable(),
  responseId: z.string().max(256).nullable(),
  providerRequestId: z.string().max(256).nullable(),
  usage: LLMUsageSchema.nullable(),
  sourceMessages: z.array(ReplyDraftSourceMessageSchema).min(1).max(8),
  draft: ReplyDraftContentSchema
}).strict();

export const StoredReplyDraftSchema = z.object({
  id: z.uuid(),
  emailId: z.uuid(),
  sourceRevision: z.number().int().min(1),
  schemaVersion: z.literal(ReplyDraftSchemaVersion),
  provider: z.string().min(1).max(64),
  modelVersion: z.string().min(1).max(128),
  subject: z.string().max(2_000),
  bodyText: z.string().max(12_000),
  claims: z.array(ReplyDraftClaimSchema).max(16),
  uncertainties: z.array(z.string().min(1).max(300)).max(10),
  sourceMessages: z.array(ReplyDraftSourceMessageSchema).min(1).max(8),
  status: z.literal("suggestion"),
  edited: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}).strict();

export const ReplyDraftGenerationResultSchema = z.object({
  suggestion: StoredReplyDraftSchema.nullable(),
  missingContextReason: z.string().min(1).max(300).nullable(),
  uncertainties: z.array(z.string().min(1).max(300)).max(10)
}).strict().superRefine((result, context) => {
  if ((result.suggestion === null) !== (result.missingContextReason !== null)) {
    context.addIssue({ code: "custom", message: "Suggestion and missing-context result must agree" });
  }
});

export const EditReplyDraftRequestSchema = z.object({
  subject: z.string().max(2_000).optional(),
  bodyText: z.string().min(1).max(12_000)
}).strict();

export type ReplyDraftMessage = z.infer<typeof ReplyDraftMessageSchema>;
export type ReplyDraftServiceRequest = z.infer<typeof ReplyDraftServiceRequestSchema>;
export type ReplyDraftContent = z.infer<typeof ReplyDraftContentSchema>;
export type ReplyDraftServiceResponse = z.infer<typeof ReplyDraftServiceResponseSchema>;
export type StoredReplyDraft = z.infer<typeof StoredReplyDraftSchema>;
export type ReplyDraftGenerationResult = z.infer<typeof ReplyDraftGenerationResultSchema>;

export const WebEnvironmentSchema = z.object({
  NEXT_PUBLIC_API_BASE_URL: z.url().default("http://localhost:4000")
}).transform((value) => ({ apiBaseUrl: value.NEXT_PUBLIC_API_BASE_URL }));

export type WebEnvironment = z.infer<typeof WebEnvironmentSchema>;
