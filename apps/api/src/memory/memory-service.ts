import {
  MemoryCreateRequestSchema,
  MemoryManagementResponseSchema,
  MemoryRetrievalRequestSchema,
  MemoryRetrievalResponseSchema,
  MemorySettingsResponseSchema,
  MemorySettingsUpdateRequestSchema,
  MemoryUpdateRequestSchema,
  USER_MEMORY_CONSENT_VERSION,
  UserMemorySchema,
  type MemoryCreateRequest,
  type MemoryUpdateRequest,
  type UserMemory
} from "@mailpilot/shared";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { ApiError } from "../errors.js";

const MEMORY_LIMIT = 50;
const RETRIEVAL_LIMIT = 10;
const RETRIEVAL_CHARACTER_LIMIT = 2_000;
const EXPIRED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MEMORY_SELECT = {
  id: true,
  userId: true,
  type: true,
  key: true,
  value: true,
  recurrence: true,
  sourceKind: true,
  sourceEmailId: true,
  sourceThreadId: true,
  sourceRevision: true,
  sourceObservedAt: true,
  confidence: true,
  confidenceBasis: true,
  status: true,
  revision: true,
  consentVersion: true,
  capturedAt: true,
  approvedAt: true,
  lastConfirmedAt: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
  sourceEmail: {
    select: {
      id: true,
      providerThreadId: true,
      sourceRevision: true,
      subject: true,
      senderEmailNormalized: true,
      receivedAt: true,
      deletedAt: true
    }
  }
} satisfies Prisma.UserMemorySelect;

type MemoryRow = Prisma.UserMemoryGetPayload<{ select: typeof MEMORY_SELECT }>;
type TransactionClient = Prisma.TransactionClient;

export class MemoryManagementService {
  public constructor(private readonly database: PrismaClient, private readonly now: () => Date = () => new Date()) {}

  public async getSettings(userId: string) {
    const settings = await this.database.userMemorySettings.findUnique({ where: { userId } });
    return MemorySettingsResponseSchema.parse({ settings: {
      mode: settings?.mode ?? "disabled",
      consentVersion: settings?.consentVersion ?? null,
      consentedAt: settings?.consentedAt?.toISOString() ?? null,
      updatedAt: settings?.updatedAt.toISOString() ?? null
    } });
  }

  public async updateSettings(userId: string, untrustedRequest: unknown, requestId?: string) {
    const parsed = MemorySettingsUpdateRequestSchema.safeParse(untrustedRequest);
    if (!parsed.success) throw new ApiError(400, "INVALID_ARGUMENT", "Memory settings are invalid");
    const now = this.now();

    if (parsed.data.mode === "paused") {
      const current = await this.database.userMemorySettings.findUnique({ where: { userId } });
      if (!current || (current.mode !== "enabled" && current.mode !== "paused")) {
        throw new ApiError(409, "MEMORY_NOT_ENABLED", "Enable memory and accept its consent notice before pausing it");
      }
    }

    const settings = await this.database.$transaction(async (transaction) => {
      let deletedCount = 0;
      const existingSettings = await transaction.userMemorySettings.findUnique({ where: { userId } });
      if (parsed.data.mode === "disabled") {
        const deleted = await transaction.userMemory.deleteMany({ where: { userId } });
        deletedCount = deleted.count;
      }
      const saved = await transaction.userMemorySettings.upsert({
        where: { userId },
        create: {
          userId,
          mode: parsed.data.mode,
          consentVersion: parsed.data.mode === "disabled" ? null : USER_MEMORY_CONSENT_VERSION,
          consentedAt: parsed.data.mode === "disabled" ? null : now,
          updatedAt: now
        },
        update: {
          mode: parsed.data.mode,
          consentVersion: parsed.data.mode === "disabled" ? null : USER_MEMORY_CONSENT_VERSION,
          consentedAt: parsed.data.mode === "disabled" ? null : (parsed.data.mode === "paused" ? existingSettings?.consentedAt ?? now : now),
          updatedAt: now
        }
      });
      await transaction.auditLog.create({
        data: {
          userId,
          actorType: "user",
          eventType: parsed.data.mode === "disabled" ? "memory.turned_off_and_deleted" : `memory.${parsed.data.mode}`,
          entityType: "user_memory_settings",
          entityId: userId,
          requestId: requestId ?? null,
          metadata: parsed.data.mode === "disabled" ? { deletedCount } : { consentVersion: USER_MEMORY_CONSENT_VERSION }
        }
      });
      return saved;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return MemorySettingsResponseSchema.parse({ settings: {
      mode: settings.mode,
      consentVersion: settings.consentVersion,
      consentedAt: settings.consentedAt?.toISOString() ?? null,
      updatedAt: settings.updatedAt.toISOString()
    } });
  }

  public async list(userId: string, requestId?: string) {
    const now = this.now();
    const rows = await this.loadAndRefreshStatuses(userId, now, requestId);
    const settings = await this.getSettings(userId);
    return MemoryManagementResponseSchema.parse({
      settings: settings.settings,
      memories: rows.map(toMemoryRecord)
    });
  }

  public async retrieve(userId: string, untrustedRequest: unknown, requestId?: string) {
    const parsed = MemoryRetrievalRequestSchema.safeParse(untrustedRequest);
    if (!parsed.success) throw new ApiError(400, "INVALID_ARGUMENT", "Memory retrieval query is invalid");
    const settings = await this.database.userMemorySettings.findUnique({ where: { userId }, select: { mode: true } });
    if (settings?.mode !== "enabled") return MemoryRetrievalResponseSchema.parse({ memories: [], totalCharacters: 0 });

    const now = this.now();
    const rows = await this.loadAndRefreshStatuses(userId, now, requestId);
    const queryTerms = new Set(tokenize(parsed.data.query));
    if (queryTerms.size === 0) return MemoryRetrievalResponseSchema.parse({ memories: [], totalCharacters: 0 });

    const scored = rows
      .filter((row) => isUsable(row, now))
      .map((row) => ({ row, score: scoreMemory(row, queryTerms) }))
      .filter((item) => item.score >= 0.15)
      .sort((left, right) => right.score - left.score
        || right.row.updatedAt.getTime() - left.row.updatedAt.getTime()
        || left.row.id.localeCompare(right.row.id));

    const memories: UserMemory[] = [];
    const seenValues = new Set<string>();
    let totalCharacters = 0;
    for (const item of scored) {
      if (memories.length >= RETRIEVAL_LIMIT) break;
      const record = toMemoryRecord(item.row);
      const normalizedValue = `${record.type}:${record.key}:${record.value.trim().toLowerCase()}`;
      if (seenValues.has(normalizedValue)) continue;
      const characters = JSON.stringify(record).length;
      if (totalCharacters + characters > RETRIEVAL_CHARACTER_LIMIT) continue;
      seenValues.add(normalizedValue);
      totalCharacters += characters;
      memories.push(UserMemorySchema.parse({ ...record, relevanceScore: Number(item.score.toFixed(4)) }));
    }
    return MemoryRetrievalResponseSchema.parse({ memories, totalCharacters });
  }

  public async create(userId: string, untrustedRequest: unknown, requestId?: string) {
    const request = parseCreateRequest(untrustedRequest);
    const now = this.now();
    return this.database.$transaction(async (transaction) => {
      await requireEnabled(transaction, userId);
      const source = await resolveSource(transaction, userId, request.sourceEmailId);
      assertRecurrenceEnd(request.type, request.recurrence, now);
      const count = await transaction.userMemory.count({ where: { userId } });
      if (count >= MEMORY_LIMIT) throw new ApiError(409, "MEMORY_LIMIT_REACHED", "Delete a saved memory before adding another");
      const key = normalizeKey(request.key);
      let created: MemoryRow;
      try {
        created = await transaction.userMemory.create({
          data: memoryCreateData(userId, request, key, source, now),
          select: MEMORY_SELECT
        });
      } catch (error: unknown) {
        if (isUniqueViolation(error)) throw new ApiError(409, "MEMORY_CONFLICT", "A memory with this type and key already exists. Review it before replacing it");
        throw error;
      }
      await writeAudit(transaction, userId, requestId, "memory.created", created.id, { sourceKind: created.sourceKind });
      return { memory: toMemoryRecord(created) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  public async update(userId: string, untrustedMemoryId: string, untrustedRequest: unknown, requestId?: string) {
    const memoryId = parseId(untrustedMemoryId);
    const request = MemoryUpdateRequestSchema.safeParse(untrustedRequest);
    if (!request.success) throw new ApiError(400, "INVALID_ARGUMENT", "Memory correction is invalid");
    const now = this.now();
    return this.database.$transaction(async (transaction) => {
      await requireManagementConsent(transaction, userId);
      const current = await transaction.userMemory.findFirst({ where: { id: memoryId, userId }, select: { id: true, revision: true } });
      if (!current) throw memoryNotFound();
      if (current.revision !== request.data.expectedRevision) throw new ApiError(409, "MEMORY_REVISION_CONFLICT", "This memory changed. Reload it and review the latest value");
      const source = await resolveSource(transaction, userId, request.data.sourceEmailId);
      assertRecurrenceEnd(request.data.type, request.data.recurrence, now);
      const key = normalizeKey(request.data.key);
      const expiry = expiryFor(request.data.type, now, request.data.recurrence);
      const updateData = {
        type: request.data.type,
        key,
        value: request.data.value,
        recurrence: recurrenceJson(request.data.recurrence),
        sourceKind: source ? "email" as const : "user_entered" as const,
        sourceEmailId: source?.id ?? null,
        sourceThreadId: source?.threadId ?? null,
        sourceRevision: source?.sourceRevision ?? null,
        sourceObservedAt: source?.receivedAt ?? null,
        confidence: null,
        confidenceBasis: "user_asserted" as const,
        status: "active" as const,
        consentVersion: USER_MEMORY_CONSENT_VERSION,
        revision: { increment: 1 },
        approvedAt: now,
        lastConfirmedAt: now,
        expiresAt: expiry,
        updatedAt: now
      } satisfies Prisma.UserMemoryUncheckedUpdateManyInput;

      try {
        const changed = await transaction.userMemory.updateMany({
          where: { id: memoryId, userId, revision: request.data.expectedRevision },
          data: updateData
        });
        if (changed.count !== 1) throw new ApiError(409, "MEMORY_REVISION_CONFLICT", "This memory changed. Reload it and review the latest value");
      } catch (error: unknown) {
        if (isUniqueViolation(error)) throw new ApiError(409, "MEMORY_CONFLICT", "A memory with this type and key already exists. Review it before replacing it");
        throw error;
      }
      const saved = await transaction.userMemory.findFirst({ where: { id: memoryId, userId }, select: MEMORY_SELECT });
      if (!saved) throw memoryNotFound();
      await writeAudit(transaction, userId, requestId, "memory.corrected", memoryId, { revision: saved.revision, sourceKind: saved.sourceKind });
      return { memory: toMemoryRecord(saved) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  public async confirm(userId: string, untrustedMemoryId: string, requestId?: string) {
    const memoryId = parseId(untrustedMemoryId);
    const now = this.now();
    return this.database.$transaction(async (transaction) => {
      const row = await transaction.userMemory.findFirst({ where: { id: memoryId, userId }, select: MEMORY_SELECT });
      if (!row) throw memoryNotFound();
      if (row.sourceKind === "email" && (!row.sourceEmail || row.sourceEmail.deletedAt || row.sourceEmail.sourceRevision !== row.sourceRevision)) {
        throw new ApiError(409, "MEMORY_SOURCE_STALE", "This memory came from an email that changed. Review and save the value again with its current source");
      }
      const expiresAt = expiryFor(row.type, now, parseRecurrence(row.recurrence));
      const changed = await transaction.userMemory.updateMany({
        where: { id: memoryId, userId, revision: row.revision },
        data: { status: "active", lastConfirmedAt: now, expiresAt, revision: { increment: 1 }, updatedAt: now }
      });
      if (changed.count !== 1) throw new ApiError(409, "MEMORY_REVISION_CONFLICT", "This memory changed. Reload it and try again");
      const saved = await transaction.userMemory.findFirst({ where: { id: memoryId, userId }, select: MEMORY_SELECT });
      if (!saved) throw memoryNotFound();
      await writeAudit(transaction, userId, requestId, "memory.confirmed", memoryId, { revision: saved.revision });
      return { memory: toMemoryRecord(saved) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  public async delete(userId: string, untrustedMemoryId: string, requestId?: string): Promise<void> {
    const memoryId = parseId(untrustedMemoryId);
    await this.database.$transaction(async (transaction) => {
      const deleted = await transaction.userMemory.deleteMany({ where: { id: memoryId, userId } });
      if (deleted.count !== 1) throw memoryNotFound();
      await writeAudit(transaction, userId, requestId, "memory.deleted", memoryId);
    });
  }

  private async loadAndRefreshStatuses(userId: string, now: Date, requestId?: string): Promise<MemoryRow[]> {
    return this.database.$transaction(async (transaction) => {
      const expiredBefore = new Date(now.getTime() - EXPIRED_RETENTION_MS);
      const pruned = await transaction.userMemory.deleteMany({ where: { userId, expiresAt: { lt: expiredBefore } } });
      if (pruned.count > 0) {
        await writeAudit(transaction, userId, requestId, "memory.expired_pruned", null, { count: pruned.count });
      }
      const rows = await transaction.userMemory.findMany({
        where: { userId },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: MEMORY_LIMIT,
        select: MEMORY_SELECT
      });
      const refreshed: MemoryRow[] = [];
      for (const row of rows) {
        const status = statusFor(row, now);
        if (status !== row.status) {
          const changed = await transaction.userMemory.updateMany({ where: { id: row.id, userId, revision: row.revision }, data: { status, updatedAt: now } });
          if (changed.count === 1) row.status = status;
        }
        refreshed.push(row);
      }
      return refreshed;
    });
  }
}

function parseCreateRequest(input: unknown): MemoryCreateRequest {
  const parsed = MemoryCreateRequestSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "INVALID_ARGUMENT", "Memory details are invalid");
  return parsed.data;
}

function parseId(input: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) throw memoryNotFound();
  return input;
}

function memoryNotFound(): ApiError {
  return new ApiError(404, "MEMORY_NOT_FOUND", "Memory was not found");
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

async function requireEnabled(transaction: TransactionClient, userId: string): Promise<void> {
  const settings = await transaction.userMemorySettings.findUnique({ where: { userId }, select: { mode: true, consentVersion: true } });
  if (settings?.mode !== "enabled" || settings.consentVersion !== USER_MEMORY_CONSENT_VERSION) {
    throw new ApiError(409, "MEMORY_DISABLED", "Enable memory and accept the current consent notice before saving or correcting items");
  }
}

async function requireManagementConsent(transaction: TransactionClient, userId: string): Promise<void> {
  const settings = await transaction.userMemorySettings.findUnique({ where: { userId }, select: { mode: true, consentVersion: true } });
  if ((settings?.mode !== "enabled" && settings?.mode !== "paused") || settings.consentVersion !== USER_MEMORY_CONSENT_VERSION) {
    throw new ApiError(409, "MEMORY_DISABLED", "Enable memory and accept the current consent notice before correcting items");
  }
}

interface ResolvedSource {
  id: string;
  threadId: string;
  sourceRevision: number;
  receivedAt: Date;
}

async function resolveSource(transaction: TransactionClient, userId: string, emailId: string | null): Promise<ResolvedSource | null> {
  if (!emailId) return null;
  const email = await transaction.email.findFirst({
    where: { id: emailId, userId, deletedAt: null },
    select: { id: true, providerThreadId: true, sourceRevision: true, receivedAt: true }
  });
  if (!email) throw new ApiError(404, "MEMORY_SOURCE_NOT_FOUND", "The selected source email is unavailable");
  return {
    id: email.id,
    threadId: email.providerThreadId,
    sourceRevision: email.sourceRevision,
    receivedAt: email.receivedAt
  };
}

function memoryCreateData(userId: string, request: MemoryCreateRequest, key: string, source: ResolvedSource | null, now: Date): Prisma.UserMemoryUncheckedCreateInput {
  return {
    userId,
    type: request.type,
    key,
    value: request.value,
    recurrence: recurrenceJson(request.recurrence),
    sourceKind: source ? "email" : "user_entered",
    ...(source ? {
      sourceEmailId: source.id,
      sourceThreadId: source.threadId,
      sourceRevision: source.sourceRevision,
      sourceObservedAt: source.receivedAt
    } : { sourceEmailId: null }),
    confidence: null,
    confidenceBasis: "user_asserted",
    status: "active",
    consentVersion: USER_MEMORY_CONSENT_VERSION,
    capturedAt: now,
    approvedAt: now,
    lastConfirmedAt: now,
    expiresAt: expiryFor(request.type, now, request.recurrence),
    updatedAt: now
  };
}

function recurrenceJson(value: MemoryCreateRequest["recurrence"] | MemoryUpdateRequest["recurrence"]): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value ? value as Prisma.InputJsonValue : Prisma.DbNull;
}

function parseRecurrence(value: Prisma.JsonValue | null): MemoryCreateRequest["recurrence"] {
  if (value === null) return null;
  const parsed = MemoryCreateRequestSchema.shape.recurrence.unwrap().safeParse(value);
  return parsed.success ? parsed.data : null;
}

function expiryFor(type: MemoryCreateRequest["type"], from: Date, recurrence: MemoryCreateRequest["recurrence"]): Date {
  const days = type === "preference" ? 365 : 90;
  const expiry = new Date(from.getTime() + days * 24 * 60 * 60 * 1_000);
  if (type === "recurring_commitment" && recurrence?.endsOn) {
    const recurrenceEnd = new Date(`${recurrence.endsOn}T23:59:59.999Z`);
    return recurrenceEnd < expiry ? recurrenceEnd : expiry;
  }
  return expiry;
}

function assertRecurrenceEnd(type: MemoryCreateRequest["type"], recurrence: MemoryCreateRequest["recurrence"], now: Date): void {
  if (type === "recurring_commitment" && recurrence?.endsOn
    && new Date(`${recurrence.endsOn}T23:59:59.999Z`).getTime() <= now.getTime()) {
    throw new ApiError(400, "INVALID_ARGUMENT", "A recurring commitment end date must be in the future");
  }
}

function statusFor(row: MemoryRow, now: Date): "active" | "stale" | "expired" {
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  if (row.sourceKind === "email" && (!row.sourceEmail || row.sourceEmail.deletedAt || row.sourceEmail.sourceRevision !== row.sourceRevision)) return "stale";
  return "active";
}

function isUsable(row: MemoryRow, now: Date): boolean {
  return statusFor(row, now) === "active" && row.expiresAt.getTime() > now.getTime();
}

function toMemoryRecord(row: MemoryRow): UserMemory {
  const recurrence = row.recurrence === null ? null : parseRecurrence(row.recurrence);
  return UserMemorySchema.parse({
    id: row.id,
    type: row.type,
    key: row.key,
    value: row.value,
    recurrence,
    source: {
      kind: row.sourceKind,
      email: row.sourceEmail ? {
        id: row.sourceEmail.id,
        threadId: row.sourceEmail.providerThreadId,
        sourceRevision: row.sourceRevision ?? row.sourceEmail.sourceRevision,
        currentRevision: row.sourceEmail.sourceRevision,
        subject: row.sourceEmail.subject,
        senderEmail: row.sourceEmail.senderEmailNormalized,
        receivedAt: row.sourceEmail.receivedAt.toISOString()
      } : null
    },
    confidence: row.confidence,
    confidenceBasis: row.confidenceBasis,
    status: row.status,
    revision: row.revision,
    capturedAt: row.capturedAt.toISOString(),
    approvedAt: row.approvedAt.toISOString(),
    lastConfirmedAt: row.lastConfirmedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  });
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9._+-]*/g)?.filter((token) => token.length > 1) ?? [];
}

function scoreMemory(row: MemoryRow, queryTerms: Set<string>): number {
  const terms = new Set(tokenize(`${row.key.replaceAll("_", " ")} ${row.value}`));
  let matches = 0;
  for (const term of queryTerms) if (terms.has(term)) matches += 1;
  const overlap = matches / queryTerms.size;
  const phraseBoost = queryTerms.size > 1 && [...queryTerms].every((term) => terms.has(term)) ? 0.1 : 0;
  return Math.min(1, overlap + phraseBoost);
}

async function writeAudit(
  transaction: TransactionClient,
  userId: string,
  requestId: string | undefined,
  eventType: string,
  entityId: string | null,
  metadata?: Record<string, number | string>
): Promise<void> {
  await transaction.auditLog.create({
    data: {
      userId,
      actorType: "user",
      eventType,
      entityType: "user_memory",
      entityId,
      requestId: requestId ?? null,
      metadata: metadata ?? Prisma.JsonNull
    }
  });
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
