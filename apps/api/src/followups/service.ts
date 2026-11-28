import {
  FollowUpManagementResponseSchema,
  FollowUpSettingsSchema,
  FollowUpSettingsUpdateRequestSchema,
  FollowUpUpdateRequestSchema,
} from "@mailpilot/shared";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { ApiError } from "../errors.js";
import { isCommitmentReminderDue, isThreadStale, localDayInterval, nextAllowedTime, remainingDailySlots } from "./scheduling.js";

const FOLLOW_UP_SELECT = {
  id: true,
  kind: true,
  status: true,
  title: true,
  reason: true,
  scheduledAt: true,
  sourceThreadId: true,
  createdAt: true,
  email: { select: { id: true, subject: true, senderEmailNormalized: true, receivedAt: true } },
  commitment: { select: { id: true, sourceEvidence: true, dueAt: true, dueTimezone: true } }
} satisfies Prisma.FollowUpSelect;
type FollowUpRow = Prisma.FollowUpGetPayload<{ select: typeof FOLLOW_UP_SELECT }>;
type FollowUpSettingsRow = Prisma.FollowUpSettingsGetPayload<Record<string, never>>;
type FollowUpSettingsInputType = z.infer<typeof FollowUpSettingsUpdateRequestSchema>;

interface StaleThreadRow {
  emailId: string;
  connectionId: string;
  threadId: string;
  subject: string;
  senderEmail: string | null;
  receivedAt: Date;
  accountEmail: string;
}

interface SuggestionCandidate {
  kind: "commitment_reminder" | "stale_thread";
  emailId: string;
  commitmentId: string | null;
  sourceThreadId: string;
  deduplicationKey: string;
  title: string;
  reason: string;
}

const DEFAULT_SETTINGS = {
  enabled: false,
  commitmentRemindersEnabled: true,
  staleThreadSuggestionsEnabled: true,
  commitmentLeadHours: 24,
  staleThreadAfterDays: 5,
  timeZone: "UTC",
  quietHoursStart: null,
  quietHoursEnd: null,
  dailySuggestionLimit: 5
} as const;

export class FollowUpService {
  public constructor(private readonly database: PrismaClient, private readonly now: () => Date = () => new Date()) {}

  public async list(userId: string) {
    const [settingsRow, followUps] = await Promise.all([
      this.database.followUpSettings.findUnique({ where: { userId } }),
      this.database.followUp.findMany({
        where: { userId, status: { in: ["planned", "completed", "dismissed"] }, scheduledAt: { lte: this.now() } },
        orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
        take: 100,
        select: FOLLOW_UP_SELECT
      })
    ]);
    return FollowUpManagementResponseSchema.parse({
      settings: serializeSettings(settingsRow),
      followUps: followUps.map(serializeFollowUp)
    });
  }

  public async updateSettings(userId: string, untrusted: unknown) {
    const parsed = FollowUpSettingsUpdateRequestSchema.safeParse(untrusted);
    if (!parsed.success) throw new ApiError(400, "INVALID_ARGUMENT", "Follow-up settings are invalid");
    try {
      new Intl.DateTimeFormat("en", { timeZone: parsed.data.timeZone }).format(this.now());
    } catch {
      throw new ApiError(400, "INVALID_ARGUMENT", "Timezone is not recognized");
    }
    const input: FollowUpSettingsInputType = parsed.data;
    const saved = await this.database.$transaction(async (transaction) => {
      await lockFollowUpUser(transaction, userId);
      const settings = await transaction.followUpSettings.upsert({
        where: { userId }, create: { userId, ...input }, update: input
      });
      if (!settings.enabled || (!settings.commitmentRemindersEnabled && !settings.staleThreadSuggestionsEnabled)) {
        await transaction.followUp.updateMany({ where: { userId, status: "planned" }, data: { status: "cancelled" } });
      } else {
        if (!settings.commitmentRemindersEnabled) {
          await transaction.followUp.updateMany({ where: { userId, kind: "commitment_reminder", status: "planned" }, data: { status: "cancelled" } });
        }
        if (!settings.staleThreadSuggestionsEnabled) {
          await transaction.followUp.updateMany({ where: { userId, kind: "stale_thread", status: "planned" }, data: { status: "cancelled" } });
        }
      }
      return settings;
    });
    return { settings: FollowUpSettingsSchema.parse(serializeSettings(saved)) };
  }

  public async update(userId: string, followUpId: string, untrusted: unknown) {
    if (!z.uuid().safeParse(followUpId).success) throw new ApiError(404, "FOLLOW_UP_NOT_FOUND", "Follow-up suggestion was not found");
    const parsed = FollowUpUpdateRequestSchema.safeParse(untrusted);
    if (!parsed.success) throw new ApiError(400, "INVALID_ARGUMENT", "Follow-up update is invalid");
    const current = await this.database.followUp.findFirst({
      where: { id: followUpId, userId, status: "planned" },
      select: { id: true, scheduledAt: true }
    });
    if (!current) throw new ApiError(404, "FOLLOW_UP_NOT_FOUND", "Follow-up suggestion was not found");
    const now = this.now();
    if (parsed.data.action === "snooze" || parsed.data.action === "snooze_one_day") {
      const requestedAt = parsed.data.action === "snooze_one_day"
        ? new Date(now.getTime() + 24 * 60 * 60 * 1_000)
        : new Date(parsed.data.scheduledAt);
      if (requestedAt.getTime() <= now.getTime() || requestedAt.getTime() > now.getTime() + 90 * 24 * 60 * 60 * 1_000) {
        throw new ApiError(400, "INVALID_ARGUMENT", "Snooze time must be within the next 90 days");
      }
      const settings = await this.database.followUpSettings.findUnique({ where: { userId } });
      const scheduledAt = settings
        ? nextAllowedTime(requestedAt, settings.timeZone, { start: settings.quietHoursStart, end: settings.quietHoursEnd })
        : requestedAt;
      await this.database.followUp.updateMany({ where: { id: current.id, userId, status: "planned" }, data: { scheduledAt } });
    } else {
      await this.database.followUp.updateMany({
        where: { id: current.id, userId, status: "planned" },
        data: parsed.data.action === "complete"
          ? { status: "completed", completedAt: now }
          : { status: "dismissed" }
      });
    }
    const updated = await this.database.followUp.findFirst({ where: { id: current.id, userId }, select: FOLLOW_UP_SELECT });
    if (!updated) throw new ApiError(404, "FOLLOW_UP_NOT_FOUND", "Follow-up suggestion was not found");
    return { followUp: serializeFollowUp(updated) };
  }

  public async listEnabledUserIds(): Promise<string[]> {
    const settings = await this.database.followUpSettings.findMany({
      where: { enabled: true, OR: [{ commitmentRemindersEnabled: true }, { staleThreadSuggestionsEnabled: true }] },
      select: { userId: true }
    });
    return settings.map((item) => item.userId);
  }

  public async scanUser(userId: string): Promise<{ created: number; cancelled: number }> {
    return this.database.$transaction(async (transaction) => {
      await lockFollowUpUser(transaction, userId);
      return this.scanUserLocked(transaction, userId);
    }, { maxWait: 5_000, timeout: 30_000 });
  }

  private async scanUserLocked(transaction: Prisma.TransactionClient, userId: string): Promise<{ created: number; cancelled: number }> {
    const settings = await transaction.followUpSettings.findUnique({ where: { userId } });
    const now = this.now();
    if (!settings?.enabled || (!settings.commitmentRemindersEnabled && !settings.staleThreadSuggestionsEnabled)) {
      const cancelled = await transaction.followUp.updateMany({ where: { userId, status: "planned" }, data: { status: "cancelled" } });
      return { created: 0, cancelled: cancelled.count };
    }

    const candidates: SuggestionCandidate[] = [];
    if (settings.commitmentRemindersEnabled) {
      const commitments = await transaction.commitment.findMany({
        where: { userId, status: "active", dueAt: { lte: new Date(now.getTime() + settings.commitmentLeadHours * 60 * 60 * 1_000) } },
        select: { id: true, statement: true, dueAt: true, dueTimezone: true, sourceThreadId: true, sourceEmailId: true, email: { select: { deletedAt: true } } },
        orderBy: [{ dueAt: "asc" }, { id: "asc" }],
        take: 500
      });
      for (const commitment of commitments) {
        if (commitment.email.deletedAt || !isCommitmentReminderDue(commitment.dueAt, now, settings.commitmentLeadHours)) continue;
        candidates.push({
          kind: "commitment_reminder",
          emailId: commitment.sourceEmailId,
          commitmentId: commitment.id,
          sourceThreadId: commitment.sourceThreadId,
          deduplicationKey: `commitment:${commitment.id}:${commitment.dueAt?.toISOString() ?? "none"}`,
          title: commitment.statement.slice(0, 300),
          reason: `A commitment is due ${commitment.dueAt?.toISOString() ?? "soon"}. Review the source conversation.`
        });
      }
    }

    if (settings.staleThreadSuggestionsEnabled) {
      const staleThreads = await this.loadLatestThreadMessages(transaction, userId);
      for (const thread of staleThreads) {
        if (thread.senderEmail?.toLowerCase() === thread.accountEmail.toLowerCase()) continue;
        if (!isThreadStale(thread.receivedAt, now, settings.staleThreadAfterDays)) continue;
        candidates.push({
          kind: "stale_thread",
          emailId: thread.emailId,
          commitmentId: null,
          sourceThreadId: thread.threadId,
          deduplicationKey: `stale:${thread.connectionId}:${thread.threadId}:${thread.emailId}`,
          title: `Follow up: ${thread.subject}`.slice(0, 300),
          reason: `No newer message has arrived in this thread for at least ${settings.staleThreadAfterDays} days.`
        });
      }
    }

    const activeKeys = new Set(candidates.map((candidate) => candidate.deduplicationKey));
    const planned = await transaction.followUp.findMany({ where: { userId, status: "planned" }, select: { id: true, deduplicationKey: true } });
    let cancelled = 0;
    for (const record of planned) {
      if (!activeKeys.has(record.deduplicationKey)) {
        const result = await transaction.followUp.updateMany({ where: { id: record.id, userId, status: "planned" }, data: { status: "cancelled" } });
        cancelled += result.count;
      }
    }

    const day = localDayInterval(now, settings.timeZone);
    const activatedToday = await transaction.followUp.count({
      where: { userId, lastActivatedAt: { gte: day.start, lt: day.end } }
    });
    let availableSlots = remainingDailySlots(settings.dailySuggestionLimit, activatedToday);
    let created = 0;
    for (const candidate of candidates) {
      const existing = await transaction.followUp.findFirst({
        where: { userId, deduplicationKey: candidate.deduplicationKey },
        select: { id: true, status: true }
      });
      if (existing?.status === "planned" || existing?.status === "completed" || existing?.status === "dismissed") continue;
      if (availableSlots <= 0) continue;
      const scheduledAt = nextAllowedTime(now, settings.timeZone, {
        start: settings.quietHoursStart,
        end: settings.quietHoursEnd
      });
      const data = {
        userId,
        emailId: candidate.emailId,
        commitmentId: candidate.commitmentId,
        sourceThreadId: candidate.sourceThreadId,
        kind: candidate.kind,
        deduplicationKey: candidate.deduplicationKey,
        title: candidate.title,
        reason: candidate.reason,
        scheduledAt,
        lastActivatedAt: now,
        status: "planned" as const
      };
      if (existing) {
        const restored = await transaction.followUp.updateMany({ where: { id: existing.id, userId, status: "cancelled" }, data: { ...data, completedAt: null } });
        if (restored.count !== 1) continue;
      } else {
        try {
          await transaction.followUp.create({ data });
        } catch (error: unknown) {
          if (!isPrismaUniqueError(error)) throw error;
          continue;
        }
      }
      availableSlots -= 1;
      created += 1;
    }
    return { created, cancelled };
  }

  private async loadLatestThreadMessages(database: Prisma.TransactionClient, userId: string): Promise<StaleThreadRow[]> {
    return database.$queryRaw<StaleThreadRow[]>`
      SELECT latest.email_id AS "emailId",
             latest.connection_id AS "connectionId",
             latest.thread_id AS "threadId",
             latest.subject AS "subject",
             latest.sender_email AS "senderEmail",
             latest.received_at AS "receivedAt",
             latest.account_email AS "accountEmail"
      FROM (
        SELECT e.id AS email_id,
               e.google_connection_id AS connection_id,
               e.provider_thread_id AS thread_id,
               e.subject,
               e.sender_email_normalized AS sender_email,
               e.received_at,
               c.provider_email_normalized AS account_email,
               e.deleted_at,
               ROW_NUMBER() OVER (
                 PARTITION BY e.google_connection_id, e.provider_thread_id
                 ORDER BY e.received_at DESC, e.id DESC
               ) AS row_number
        FROM app.emails AS e
        JOIN app.google_connections AS c
          ON c.id = e.google_connection_id AND c.user_id = e.user_id
        WHERE e.user_id = ${userId}::uuid AND c.status = 'active'
      ) AS latest
      WHERE latest.row_number = 1 AND latest.deleted_at IS NULL
    `;
  }
}

async function lockFollowUpUser(transaction: Prisma.TransactionClient, userId: string): Promise<void> {
  await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('mailpilot.followups'), hashtext(${userId}))`;
}

function serializeSettings(settings: FollowUpSettingsRow | null) {
  return {
    ...DEFAULT_SETTINGS,
    ...(settings ? {
      enabled: settings.enabled,
      commitmentRemindersEnabled: settings.commitmentRemindersEnabled,
      staleThreadSuggestionsEnabled: settings.staleThreadSuggestionsEnabled,
      commitmentLeadHours: settings.commitmentLeadHours,
      staleThreadAfterDays: settings.staleThreadAfterDays,
      timeZone: settings.timeZone,
      quietHoursStart: settings.quietHoursStart,
      quietHoursEnd: settings.quietHoursEnd,
      dailySuggestionLimit: settings.dailySuggestionLimit
    } : {}),
    updatedAt: settings?.updatedAt.toISOString() ?? null
  };
}

function serializeFollowUp(row: FollowUpRow) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    reason: row.reason,
    scheduledAt: row.scheduledAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    sourceThreadId: row.sourceThreadId,
    sourceEmail: {
      id: row.email.id,
      subject: row.email.subject.slice(0, 2_000),
      senderEmail: row.email.senderEmailNormalized,
      receivedAt: row.email.receivedAt.toISOString()
    },
    commitment: row.commitment ? {
      id: row.commitment.id,
      evidence: row.commitment.sourceEvidence.slice(0, 3_000),
      dueAt: row.commitment.dueAt?.toISOString() ?? null,
      dueTimezone: row.commitment.dueTimezone
    } : null
  };
}

function isPrismaUniqueError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
