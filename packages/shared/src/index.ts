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

export const GoogleCalendarScope = "https://www.googleapis.com/auth/calendar.events.owned" as const;
export const GoogleCalendarConnectionDetailsSchema = z.object({
  email: z.string().email(),
  status: GmailConnectionStatusSchema,
  grantedScopes: z.array(z.string()),
  connectedAt: z.iso.datetime(),
  disconnectedAt: z.iso.datetime().nullable(),
  reauthRequired: z.boolean()
}).strict();
export const GoogleCalendarConnectionResponseSchema = z.object({
  connection: GoogleCalendarConnectionDetailsSchema.nullable(),
  eventCreationEnabled: z.boolean()
}).strict();
export type GoogleCalendarConnectionResponse = z.infer<typeof GoogleCalendarConnectionResponseSchema>;

export const GmailSyncProgressSchema = z.object({
  syncId: z.uuid(),
  mode: z.enum(["initial", "incremental"]),
  status: z.enum(["pending", "running", "partial", "completed", "cancelled", "resync_required", "failed"]),
  listedCount: z.number().int().nonnegative(),
  processedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  maxMessages: z.number().int().positive().nullable(),
  limitReached: z.boolean(),
  safeErrorCode: z.string().max(128).nullable(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable()
}).strict();

export const GmailSyncResponseSchema = z.object({
  sync: GmailSyncProgressSchema
}).strict();

export const GmailActiveSyncResponseSchema = z.object({
  sync: GmailSyncProgressSchema.nullable()
}).strict();

export type GmailSyncProgress = z.infer<typeof GmailSyncProgressSchema>;

export const ActionProposalSchemaVersion = "action-proposal-v1" as const;
export const ActionProposalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "executing",
  "succeeded",
  "failed",
  "reconciliation_required",
  "expired",
  "cancelled"
]);
export const ActionRiskLevelSchema = z.enum(["low", "medium", "high"]);

export const ActionProposalEvidenceSchema = z.object({
  emailId: z.uuid(),
  threadId: z.string().min(1).max(255),
  sourceRevision: z.number().int().positive(),
  quote: z.string().min(5).max(1_000).refine((value) => value.trim().length > 0)
}).strict();

const EmailRecipientSchema = z.string().email().max(320).refine((value) => value === value.trim());
const EmailSubjectSchema = z.string().min(1).max(998)
  .refine((value) => value.trim().length > 0)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const EmailBodySchema = z.string().min(1).max(100_000)
  .refine((value) => value.trim().length > 0)
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));

export const SendEmailActionPayloadSchema = z.object({
  to: z.array(EmailRecipientSchema).min(1).max(10),
  cc: z.array(EmailRecipientSchema).max(10).default([]),
  bcc: z.array(EmailRecipientSchema).max(10).default([]),
  subject: EmailSubjectSchema,
  bodyText: EmailBodySchema,
  replyToEmailId: z.uuid().nullable().default(null)
}).strict().superRefine((payload, context) => {
  const recipients = [...payload.to, ...payload.cc, ...payload.bcc];
  const normalized = recipients.map((recipient) => recipient.toLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    context.addIssue({ code: "custom", path: ["to"], message: "Recipient addresses must be unique across to, cc, and bcc" });
  }
  if (recipients.length > 20) {
    context.addIssue({ code: "custom", path: ["to"], message: "At most 20 recipients are supported" });
  }
});

export const CreateTaskActionPayloadSchema = z.object({
  title: z.string().min(1).max(500).refine((value) => value.trim().length > 0)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  description: z.string().max(10_000).nullable(),
  dueAt: z.iso.datetime().nullable(),
  sourceEmailId: z.uuid().nullable()
}).strict();

export const ScheduleFollowUpActionPayloadSchema = z.object({
  emailId: z.uuid(),
  scheduledAt: z.iso.datetime()
}).strict();

const CalendarTimezoneSchema = z.string().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Time zone must be a valid IANA time zone");

export const CreateCalendarEventActionPayloadSchema = z.object({
  title: z.string().min(1).max(200).refine((value) => value.trim().length > 0)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
  startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  endLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  timezone: CalendarTimezoneSchema,
  location: z.string().max(240).nullable(),
  sourceEmailId: z.uuid()
}).strict().superRefine((payload, context) => {
  const startAt = Date.parse(payload.startAt);
  const endAt = Date.parse(payload.endAt);
  const startInstant = resolveZonedLocalTime(payload.startLocal, payload.timezone);
  const endInstant = resolveZonedLocalTime(payload.endLocal, payload.timezone);
  if (startInstant === null) {
    context.addIssue({ code: "custom", path: ["startLocal"], message: "Start time must exist exactly once in the selected time zone" });
  } else if (startAt !== startInstant) {
    context.addIssue({ code: "custom", path: ["startAt"], message: "Start instant does not match its local time and time zone" });
  }
  if (endInstant === null) {
    context.addIssue({ code: "custom", path: ["endLocal"], message: "End time must exist exactly once in the selected time zone" });
  } else if (endAt !== endInstant) {
    context.addIssue({ code: "custom", path: ["endAt"], message: "End instant does not match its local time and time zone" });
  }
  if (endAt <= startAt) {
    context.addIssue({ code: "custom", path: ["endAt"], message: "Event end must follow its start" });
  }
});

function resolveZonedLocalTime(value: string, timezone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const [year, month, day, hour, minute] = [yearText, monthText, dayText, hourText, minuteText].map(Number);
  const naiveLocal = Date.UTC(year ?? 0, (month ?? 1) - 1, day, hour, minute);
  const checkDate = new Date(naiveLocal);
  if (checkDate.getUTCFullYear() !== year || checkDate.getUTCMonth() !== (month ?? 1) - 1
    || checkDate.getUTCDate() !== day || checkDate.getUTCHours() !== hour || checkDate.getUTCMinutes() !== minute) return null;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA-u-hc-h23", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    });
  } catch {
    return null;
  }
  const minuteMs = 60_000;
  const possibleInstants = new Set<number>();
  for (let deltaHours = -36; deltaHours <= 36; deltaHours += 3) {
    const sample = naiveLocal + deltaHours * 60 * minuteMs;
    const sampled = formatter.formatToParts(new Date(sample));
    const sampledPart = (key: string) => Number(sampled.find((item) => item.type === key)?.value);
    const sampledLocal = Date.UTC(
      sampledPart("year"), sampledPart("month") - 1, sampledPart("day"),
      sampledPart("hour"), sampledPart("minute"), sampledPart("second")
    );
    const offsetMs = sampledLocal - sample;
    const candidate = naiveLocal - offsetMs;
    const candidateParts = formatter.formatToParts(new Date(candidate));
    const candidatePart = (key: string) => Number(candidateParts.find((item) => item.type === key)?.value);
    if (candidatePart("year") === year && candidatePart("month") === month && candidatePart("day") === day
      && candidatePart("hour") === hour && candidatePart("minute") === minute && candidatePart("second") === 0) {
      possibleInstants.add(candidate);
    }
  }
  return possibleInstants.size === 1 ? [...possibleInstants][0] ?? null : null;
}

export type CreateCalendarEventActionPayload = z.infer<typeof CreateCalendarEventActionPayloadSchema>;

const ProposalRequestMetadataSchema = {
  agentRunId: z.uuid(),
  idempotencyKey: z.uuid(),
  sourceEvidence: z.array(ActionProposalEvidenceSchema).min(1).max(16)
};

function requireEvidenceForEmail(
  evidence: Array<z.infer<typeof ActionProposalEvidenceSchema>>,
  emailId: string | null,
  context: z.RefinementCtx
): void {
  if (emailId && !evidence.some((item) => item.emailId === emailId)) {
    context.addIssue({ code: "custom", path: ["sourceEvidence"], message: "Action source must be included in its evidence" });
  }
}

export const CreateActionProposalRequestSchema = z.discriminatedUnion("actionType", [
  z.object({
    ...ProposalRequestMetadataSchema,
    actionType: z.literal("send_email"),
    payload: SendEmailActionPayloadSchema
  }).strict().superRefine((request, context) => {
    requireEvidenceForEmail(request.sourceEvidence, request.payload.replyToEmailId, context);
  }),
  z.object({
    ...ProposalRequestMetadataSchema,
    actionType: z.literal("create_task"),
    payload: CreateTaskActionPayloadSchema
  }).strict().superRefine((request, context) => {
    requireEvidenceForEmail(request.sourceEvidence, request.payload.sourceEmailId, context);
  }),
  z.object({
    ...ProposalRequestMetadataSchema,
    actionType: z.literal("schedule_follow_up"),
    payload: ScheduleFollowUpActionPayloadSchema
  }).strict().superRefine((request, context) => {
    requireEvidenceForEmail(request.sourceEvidence, request.payload.emailId, context);
  }),
  z.object({
    agentRunId: z.null().default(null),
    idempotencyKey: z.uuid(),
    sourceEvidence: z.array(ActionProposalEvidenceSchema).min(1).max(16),
    actionType: z.literal("create_calendar_event"),
    payload: CreateCalendarEventActionPayloadSchema
  }).strict().superRefine((request, context) => {
    requireEvidenceForEmail(request.sourceEvidence, request.payload.sourceEmailId, context);
  })
]);

const ProposalSnapshotMetadataSchema = {
  schemaVersion: z.literal(ActionProposalSchemaVersion),
  userId: z.uuid(),
  agentRunId: z.uuid().nullable(),
  idempotencyKey: z.uuid(),
  sourceEvidence: z.array(ActionProposalEvidenceSchema).min(1).max(16),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime()
};

export const ActionProposalSnapshotSchema = z.discriminatedUnion("actionType", [
  z.object({
    ...ProposalSnapshotMetadataSchema,
    actionType: z.literal("send_email"),
    payload: SendEmailActionPayloadSchema,
    riskLevel: z.literal("high")
  }).strict(),
  z.object({
    ...ProposalSnapshotMetadataSchema,
    actionType: z.literal("create_task"),
    payload: CreateTaskActionPayloadSchema,
    riskLevel: z.literal("low")
  }).strict(),
  z.object({
    ...ProposalSnapshotMetadataSchema,
    actionType: z.literal("schedule_follow_up"),
    payload: ScheduleFollowUpActionPayloadSchema,
    riskLevel: z.literal("medium")
  }).strict(),
  z.object({
    ...ProposalSnapshotMetadataSchema,
    agentRunId: z.null(),
    actionType: z.literal("create_calendar_event"),
    payload: CreateCalendarEventActionPayloadSchema,
    riskLevel: z.literal("medium")
  }).strict()
]).superRefine((snapshot, context) => {
  if (Date.parse(snapshot.expiresAt) <= Date.parse(snapshot.createdAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Proposal expiry must follow its creation time" });
  }
  if (snapshot.actionType !== "create_calendar_event" && snapshot.agentRunId === null) {
    context.addIssue({ code: "custom", path: ["agentRunId"], message: "Workflow actions require a completed agent run" });
  }
  const linkedEmailId = snapshot.actionType === "send_email"
    ? snapshot.payload.replyToEmailId
    : snapshot.actionType === "create_task" ? snapshot.payload.sourceEmailId
      : snapshot.actionType === "schedule_follow_up" ? snapshot.payload.emailId
        : snapshot.payload.sourceEmailId;
  requireEvidenceForEmail(snapshot.sourceEvidence, linkedEmailId, context);
});

export const ActionProposalSchema = z.object({
  id: z.uuid(),
  status: ActionProposalStatusSchema,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot: ActionProposalSnapshotSchema,
  execution: z.object({
    attempts: z.number().int().nonnegative(),
    startedAt: z.iso.datetime().nullable(),
    leaseExpiresAt: z.iso.datetime().nullable(),
    resultCode: z.string().max(128).nullable()
  }).strict()
}).strict();

export const ActionProposalListResponseSchema = z.object({
  proposals: z.array(ActionProposalSchema).max(100)
}).strict();

export const ActionProposalResponseSchema = z.object({
  proposal: ActionProposalSchema
}).strict();

export const ActionProposalDecisionRequestSchema = z.object({
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export type ActionProposalEvidence = z.infer<typeof ActionProposalEvidenceSchema>;
export type CreateActionProposalRequest = z.infer<typeof CreateActionProposalRequestSchema>;
export type ActionProposalSnapshot = z.infer<typeof ActionProposalSnapshotSchema>;
export type ActionProposal = z.infer<typeof ActionProposalSchema>;

export const EmailAnalysisSchemaVersion = "email-analysis-v2" as const;

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
  dueDateBasis: z.enum(["explicit", "inferred", "none"]),
  evidence: z.string().min(1).max(500)
}).strict().superRefine((item, context) => {
  if ((item.dueDate === null) !== (item.dueDateBasis === "none")) {
    context.addIssue({
      code: "custom",
      message: "A missing action-item date must use the none basis, and a date must have explicit or inferred basis",
      path: ["dueDateBasis"]
    });
  }
});

export const TaskStatusSchema = z.enum([
  "pending_review",
  "active",
  "completed",
  "dismissed",
  "superseded"
]);
export const TaskListFilterSchema = z.enum(["all", "open", "completed", "dismissed", "superseded"]);

export const TaskDueDateSourceSchema = z.enum([
  "explicit",
  "inferred",
  "user",
  "none",
  "unknown"
]);

export const TaskRecordSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(500),
  assignee: z.enum(["user", "sender", "other", "unknown"]),
  status: TaskStatusSchema,
  dueAt: z.iso.datetime().nullable(),
  dueTimezone: z.string().max(128).nullable(),
  dueDateSource: TaskDueDateSourceSchema,
  confidence: z.number().min(0).max(1).nullable(),
  sourceEmailId: z.uuid().nullable(),
  sourceThreadId: z.string().max(255).nullable(),
  sourceRevision: z.number().int().min(1),
  sourceEvidence: z.string().nullable(),
  sourceEmail: z.object({
    id: z.uuid(),
    providerThreadId: z.string().max(255),
    subject: z.string().max(2_000),
    senderName: z.string().max(320).nullable(),
    senderEmail: z.string().max(320).nullable(),
    receivedAt: z.iso.datetime()
  }).strict().nullable(),
  titleEditedAt: z.iso.datetime().nullable(),
  lastObservedAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  dismissedAt: z.iso.datetime().nullable(),
  supersededAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}).strict();

export const TaskListResponseSchema = z.object({
  tasks: z.array(TaskRecordSchema).max(100)
}).strict();

export const TaskReadResponseSchema = z.object({
  task: TaskRecordSchema
}).strict();

export const TaskUpdateRequestSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  dueDate: z.iso.date().nullable().optional(),
  status: z.enum(["completed", "dismissed"]).optional()
}).strict()
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: "At least one task update is required"
  })
  .refine((input) => input.status === undefined || (input.title === undefined && input.dueDate === undefined), {
    message: "A status change must be submitted separately from task edits"
  });

export const FollowUpKindSchema = z.enum(["commitment_reminder", "stale_thread"]);
export const FollowUpStatusSchema = z.enum(["planned", "completed", "cancelled", "dismissed"]);
const FollowUpSettingsBaseSchema = z.object({
  enabled: z.boolean(),
  commitmentRemindersEnabled: z.boolean(),
  staleThreadSuggestionsEnabled: z.boolean(),
  commitmentLeadHours: z.number().int().min(0).max(168),
  staleThreadAfterDays: z.number().int().min(1).max(90),
  timeZone: z.string().min(1).max(64),
  quietHoursStart: z.number().int().min(0).max(23).nullable(),
  quietHoursEnd: z.number().int().min(0).max(23).nullable(),
  dailySuggestionLimit: z.number().int().min(1).max(20),
  updatedAt: z.iso.datetime().nullable()
}).strict();

type FollowUpSettingsValues = Omit<z.infer<typeof FollowUpSettingsBaseSchema>, "updatedAt">;

function validateFollowUpSettings(
  settings: FollowUpSettingsValues,
  context: z.RefinementCtx
): void {
  if ((settings.quietHoursStart === null) !== (settings.quietHoursEnd === null)) {
    context.addIssue({ code: "custom", message: "Quiet hours need both a start and end", path: ["quietHoursEnd"] });
  }
  if (settings.quietHoursStart !== null && settings.quietHoursStart === settings.quietHoursEnd) {
    context.addIssue({ code: "custom", message: "Quiet hours must cover less than 24 hours", path: ["quietHoursEnd"] });
  }
  try { new Intl.DateTimeFormat("en", { timeZone: settings.timeZone }).format(new Date()); }
  catch { context.addIssue({ code: "custom", message: "Timezone is not recognized", path: ["timeZone"] }); }
}

export const FollowUpSettingsSchema = FollowUpSettingsBaseSchema.superRefine(validateFollowUpSettings);
export const FollowUpSettingsUpdateRequestSchema = FollowUpSettingsBaseSchema
  .omit({ updatedAt: true })
  .superRefine(validateFollowUpSettings);
export const FollowUpRecordSchema = z.object({
  id: z.uuid(),
  kind: FollowUpKindSchema,
  status: FollowUpStatusSchema,
  title: z.string().min(1).max(300),
  reason: z.string().min(1).max(500),
  scheduledAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  sourceThreadId: z.string().min(1).max(255),
  sourceEmail: z.object({
    id: z.uuid(),
    subject: z.string().max(2_000),
    senderEmail: z.string().max(320).nullable(),
    receivedAt: z.iso.datetime()
  }).strict(),
  commitment: z.object({
    id: z.uuid(),
    evidence: z.string().max(3_000),
    dueAt: z.iso.datetime().nullable(),
    dueTimezone: z.string().max(128).nullable()
  }).strict().nullable()
}).strict();
export const FollowUpManagementResponseSchema = z.object({
  settings: FollowUpSettingsSchema,
  followUps: z.array(FollowUpRecordSchema).max(100)
}).strict();
export const FollowUpSettingsResponseSchema = z.object({ settings: FollowUpSettingsSchema }).strict();
export const FollowUpStatusResponseSchema = z.object({ followUp: FollowUpRecordSchema }).strict();
export const FollowUpUpdateRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["complete", "dismiss"]) }).strict(),
  z.object({ action: z.literal("snooze"), scheduledAt: z.iso.datetime() }).strict(),
  z.object({ action: z.literal("snooze_one_day") }).strict()
]);

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
export type EmailEventCandidate = z.infer<typeof EmailEventCandidateSchema>;

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
  threadId: z.string().min(1).max(255),
  senderName: z.string().max(320).nullable(),
  senderEmail: z.string().max(320).nullable(),
  receivedAt: z.iso.datetime(),
  labels: z.array(z.string().max(255)),
  sourceRevision: z.number().int().min(1)
}).strict();

export const SyncedEmailListResponseSchema = z.object({
  emails: z.array(SyncedEmailSummarySchema).max(51)
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

export const USER_MEMORY_CONSENT_VERSION = "memory-v1" as const;
export const MemoryModeSchema = z.enum(["disabled", "enabled", "paused"]);
export const MemoryTypeSchema = z.enum(["preference", "recurring_commitment", "relevant_fact"]);
export const MemoryStatusSchema = z.enum(["active", "stale", "expired"]);
export const MemorySourceKindSchema = z.enum(["user_entered", "email"]);
export const MemoryConfidenceBasisSchema = z.enum(["user_asserted", "model_evidence"]);

export const MemoryRecurrenceSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]),
  interval: z.number().int().min(1).max(12),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7),
  monthDay: z.number().int().min(1).max(31).nullable(),
  timezone: z.string().min(1).max(64).refine(isValidTimezone, "Time zone must be a valid IANA time zone"),
  endsOn: z.iso.date().nullable()
}).strict().superRefine((recurrence, context) => {
  if (new Set(recurrence.weekdays).size !== recurrence.weekdays.length) {
    context.addIssue({ code: "custom", path: ["weekdays"], message: "Weekdays must be unique" });
  }
  if (recurrence.frequency === "weekly" && recurrence.weekdays.length === 0) {
    context.addIssue({ code: "custom", path: ["weekdays"], message: "Choose at least one weekday for a weekly recurrence" });
  }
  if (recurrence.frequency !== "weekly" && recurrence.weekdays.length > 0) {
    context.addIssue({ code: "custom", path: ["weekdays"], message: "Weekdays are only used for weekly recurrences" });
  }
  if ((recurrence.frequency === "monthly") !== (recurrence.monthDay !== null)) {
    context.addIssue({ code: "custom", path: ["monthDay"], message: "A month day is required only for monthly recurrences" });
  }
});

const MemoryTextSchema = z.string().trim().min(1).max(300)
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "Memory text contains unsupported control characters")
  .refine((value) => !/\b(ignore (?:all |any )?(?:previous|prior)|system prompt|developer message|bypass (?:approval|security)|override (?:policy|instructions?)|api key|password|access token|refresh token)\b/i.test(value), "Memory text cannot contain policy instructions or credentials");
const MemoryKeySchema = z.string().trim().min(1).max(96).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i);
const MemoryPreferenceKeySchema = z.enum(["reply_tone", "response_language", "display_timezone"]);

export const MemoryCreateRequestSchema = z.object({
  type: MemoryTypeSchema,
  key: z.string().trim().min(1).max(96),
  value: MemoryTextSchema,
  sourceEmailId: z.uuid().nullable().default(null),
  recurrence: MemoryRecurrenceSchema.nullable().default(null)
}).strict().superRefine(validateMemoryDraft);

export const MemoryUpdateRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  type: MemoryTypeSchema,
  key: z.string().trim().min(1).max(96),
  value: MemoryTextSchema,
  sourceEmailId: z.uuid().nullable(),
  recurrence: MemoryRecurrenceSchema.nullable()
}).strict().superRefine(validateMemoryDraft);

export const MemorySettingsUpdateRequestSchema = z.object({
  mode: z.enum(["enabled", "paused", "disabled"]),
  consentVersion: z.literal(USER_MEMORY_CONSENT_VERSION).optional()
}).strict().superRefine((settings, context) => {
  if (settings.mode === "enabled" && settings.consentVersion !== USER_MEMORY_CONSENT_VERSION) {
    context.addIssue({ code: "custom", path: ["consentVersion"], message: "Current memory consent is required" });
  }
  if (settings.mode !== "enabled" && settings.consentVersion !== undefined) {
    context.addIssue({ code: "custom", path: ["consentVersion"], message: "Consent version is only accepted when enabling memory" });
  }
});

export const MemoryRetrievalRequestSchema = z.object({
  query: z.string().trim().min(1).max(500)
}).strict();

export const MemorySettingsSchema = z.object({
  mode: MemoryModeSchema,
  consentVersion: z.string().max(32).nullable(),
  consentedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime().nullable()
}).strict();

export const MemorySourceSchema = z.object({
  kind: MemorySourceKindSchema,
  email: z.object({
    id: z.uuid(),
    threadId: z.string().min(1).max(255),
    sourceRevision: z.number().int().positive(),
    currentRevision: z.number().int().positive(),
    subject: z.string().max(2_000),
    senderEmail: z.string().max(320).nullable(),
    receivedAt: z.iso.datetime()
  }).strict().nullable()
}).strict();

export const UserMemorySchema = z.object({
  id: z.uuid(),
  type: MemoryTypeSchema,
  key: MemoryKeySchema,
  value: MemoryTextSchema,
  recurrence: MemoryRecurrenceSchema.nullable(),
  source: MemorySourceSchema,
  confidence: z.number().min(0).max(1).nullable(),
  confidenceBasis: MemoryConfidenceBasisSchema,
  status: MemoryStatusSchema,
  revision: z.number().int().positive(),
  capturedAt: z.iso.datetime(),
  approvedAt: z.iso.datetime(),
  lastConfirmedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  relevanceScore: z.number().min(0).max(1).optional()
}).strict();

export const MemoryManagementResponseSchema = z.object({
  settings: MemorySettingsSchema,
  memories: z.array(UserMemorySchema).max(50)
}).strict();
export const MemorySettingsResponseSchema = z.object({ settings: MemorySettingsSchema }).strict();
export const MemoryItemResponseSchema = z.object({ memory: UserMemorySchema }).strict();
export const MemoryRetrievalResponseSchema = z.object({ memories: z.array(UserMemorySchema).max(10), totalCharacters: z.number().int().nonnegative() }).strict();

export type MemoryType = z.infer<typeof MemoryTypeSchema>;
export type MemoryRecurrence = z.infer<typeof MemoryRecurrenceSchema>;
export type UserMemory = z.infer<typeof UserMemorySchema>;
export type MemoryCreateRequest = z.infer<typeof MemoryCreateRequestSchema>;
export type MemoryUpdateRequest = z.infer<typeof MemoryUpdateRequestSchema>;

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function validateMemoryDraft(
  draft: { type: "preference" | "recurring_commitment" | "relevant_fact"; key: string; value: string; sourceEmailId: string | null; recurrence: z.infer<typeof MemoryRecurrenceSchema> | null },
  context: z.RefinementCtx
): void {
  const normalizedKey = draft.key.trim().toLowerCase();
  if (!MemoryKeySchema.safeParse(normalizedKey).success) {
    context.addIssue({ code: "custom", path: ["key"], message: "Use letters, numbers, dots, underscores, or hyphens in the key" });
  }
  if (draft.type === "preference") {
    if (!MemoryPreferenceKeySchema.safeParse(normalizedKey).success) {
      context.addIssue({ code: "custom", path: ["key"], message: "Preference key is not supported" });
    }
    const allowedValues: Record<string, RegExp> = {
      reply_tone: /^(concise|warm|formal|friendly)$/i,
      response_language: /^(english|spanish|french|german|hindi|italian|japanese|portuguese)$/i,
      display_timezone: /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)+$/
    };
    if (!allowedValues[normalizedKey]?.test(draft.value.trim())
      || (normalizedKey === "display_timezone" && !isValidTimezone(draft.value.trim()))) {
      context.addIssue({ code: "custom", path: ["value"], message: "This preference value is not supported" });
    }
  }
  if ((draft.type === "recurring_commitment") !== (draft.recurrence !== null)) {
    context.addIssue({ code: "custom", path: ["recurrence"], message: "Recurring commitments require a recurrence rule; other memory types do not use one" });
  }
  if (draft.type === "recurring_commitment" && draft.key.trim().length < 2) {
    context.addIssue({ code: "custom", path: ["key"], message: "Add a descriptive key for the recurring commitment" });
  }
}

export const WebEnvironmentSchema = z.object({
  NEXT_PUBLIC_API_BASE_URL: z.url().default("http://localhost:4000")
}).transform((value) => ({ apiBaseUrl: value.NEXT_PUBLIC_API_BASE_URL }));

export type WebEnvironment = z.infer<typeof WebEnvironmentSchema>;
