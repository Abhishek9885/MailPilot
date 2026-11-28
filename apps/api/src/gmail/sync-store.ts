import {
  GmailSyncMode as DatabaseSyncMode,
  GmailSyncRunStatus as DatabaseSyncStatus,
  Prisma,
  type GmailSyncRun as DatabaseSyncRun,
  type PrismaClient
} from "../generated/prisma/client.js";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { randomUUID } from "node:crypto";

const PendingMessageIdsSchema = z.array(z.string().min(1));

export type GmailSyncMode = "initial" | "incremental";
export type GmailSyncStatus = "pending" | "running" | "partial" | "completed" | "cancelled" | "resync_required" | "failed";

export interface GmailSyncConnection {
  id: string;
  status: "active" | "reauth_required" | "disconnected";
  gmailHistoryId: string | null;
}

export interface GmailSyncRunRecord {
  id: string;
  userId: string;
  googleConnectionId: string;
  mode: GmailSyncMode;
  status: GmailSyncStatus;
  startHistoryId: string | null;
  targetHistoryId: string | null;
  pageToken: string | null;
  nextPageToken: string | null;
  pendingMessageIds: string[];
  maxMessages: number;
  listedCount: number;
  processedCount: number;
  failedCount: number;
  limitReached: boolean;
  cancelRequestedAt: Date | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  safeErrorCode: string | null;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GmailSyncRunStore {
  getConnectionForUser(userId: string): Promise<GmailSyncConnection | null>;
  getActiveRun(userId: string, googleConnectionId: string): Promise<GmailSyncRunRecord | null>;
  createRun(input: {
    userId: string;
    googleConnectionId: string;
    mode: GmailSyncMode;
    startHistoryId: string;
    maxMessages: number;
    requestId?: string;
  }): Promise<GmailSyncRunRecord>;
  getRun(userId: string, runId: string): Promise<GmailSyncRunRecord | null>;
  claimRun(userId: string, runId: string, leaseToken: string, now: Date, leaseExpiresAt: Date): Promise<GmailSyncRunRecord>;
  getLeasedRun(userId: string, runId: string, leaseToken: string, leaseExpiresAt: Date): Promise<GmailSyncRunRecord>;
  stagePage(input: {
    userId: string;
    runId: string;
    leaseToken: string;
    messageIds: string[];
    nextPageToken: string | undefined;
    targetHistoryId: string | undefined;
    limitReached: boolean;
  }): Promise<GmailSyncRunRecord>;
  finishMessage(
    userId: string,
    runId: string,
    leaseToken: string,
    messageId: string,
    failed: boolean,
    safeErrorCode: string | undefined,
    now: Date,
    leaseExpiresAt: Date
  ): Promise<GmailSyncRunRecord>;
  finishStep(userId: string, runId: string, leaseToken: string, now: Date): Promise<GmailSyncRunRecord>;
  releasePartial(userId: string, runId: string, leaseToken: string, safeErrorCode: string): Promise<GmailSyncRunRecord>;
  failRun(userId: string, runId: string, leaseToken: string, safeErrorCode: string, now: Date): Promise<GmailSyncRunRecord>;
  failAfterQueueRetries?(userId: string, runId: string, safeErrorCode: string, now: Date): Promise<GmailSyncRunRecord>;
  requireResync(userId: string, runId: string, leaseToken: string, now: Date): Promise<GmailSyncRunRecord>;
  requestCancellation(userId: string, runId: string, now: Date): Promise<GmailSyncRunRecord | null>;
  cancelActiveForConnection(userId: string, googleConnectionId: string, now: Date): Promise<void>;
}

export class PrismaGmailSyncRunStore implements GmailSyncRunStore {
  public constructor(private readonly database: PrismaClient) {}

  public async getConnectionForUser(userId: string): Promise<GmailSyncConnection | null> {
    return this.database.googleConnection.findUnique({
      where: { userId },
      select: { id: true, status: true, gmailHistoryId: true }
    });
  }

  public async getActiveRun(userId: string, googleConnectionId: string): Promise<GmailSyncRunRecord | null> {
    const run = await this.database.gmailSyncRun.findUnique({
      where: { activeConnectionId: googleConnectionId }
    });
    return run?.userId === userId ? mapRun(run) : null;
  }

  public async createRun(input: {
    userId: string;
    googleConnectionId: string;
    mode: GmailSyncMode;
    startHistoryId: string;
    maxMessages: number;
    requestId?: string;
  }): Promise<GmailSyncRunRecord> {
    try {
      return await this.database.$transaction(async (transaction) => {
        const connection = await transaction.googleConnection.findFirst({
          where: { id: input.googleConnectionId, userId: input.userId, status: "active" },
          select: { id: true, gmailHistoryId: true }
        });
        if (!connection) {
          throw new ApiError(404, "GMAIL_CONNECTION_NOT_FOUND", "Connected Gmail account was not found");
        }
        if (input.mode === "incremental" && !connection.gmailHistoryId) {
          throw new ApiError(409, "INITIAL_SYNC_REQUIRED", "Run an initial Gmail sync before requesting incremental sync");
        }
        if (input.mode === "incremental" && connection.gmailHistoryId !== input.startHistoryId) {
          throw new ApiError(409, "SYNC_CURSOR_CHANGED", "The Gmail sync cursor changed; start a new incremental sync");
        }
        const active = await transaction.gmailSyncRun.findUnique({
          where: { activeConnectionId: input.googleConnectionId },
          select: { id: true }
        });
        if (active) throw new ApiError(409, "SYNC_ALREADY_ACTIVE", "A Gmail sync is already active");

        const run = await transaction.gmailSyncRun.create({
          data: {
            userId: input.userId,
            googleConnectionId: input.googleConnectionId,
            activeConnectionId: input.googleConnectionId,
            mode: input.mode === "initial" ? DatabaseSyncMode.initial : DatabaseSyncMode.incremental,
            status: DatabaseSyncStatus.pending,
            startHistoryId: input.startHistoryId,
            maxMessages: input.maxMessages,
            pendingMessageIds: []
          }
        });
        await transaction.jobOutboxEvent.create({
          data: {
            userId: input.userId,
            jobType: "gmail_sync",
            idempotencyKey: `gmail-sync_${run.id}`,
            aggregateId: run.id,
            payload: {
              type: "gmail.sync",
              userId: input.userId,
              syncId: run.id,
              requestId: input.requestId ?? randomUUID()
            }
          }
        });
        return mapRun(run);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error: unknown) {
      if (isPrismaCode(error, "P2002") || isPrismaCode(error, "P2034")) {
        throw new ApiError(409, "SYNC_ALREADY_ACTIVE", "A Gmail sync is already active");
      }
      throw error;
    }
  }

  public async getRun(userId: string, runId: string): Promise<GmailSyncRunRecord | null> {
    const run = await this.database.gmailSyncRun.findUnique({
      where: { userId_id: { userId, id: runId } }
    });
    return run ? mapRun(run) : null;
  }

  public async claimRun(
    userId: string,
    runId: string,
    leaseToken: string,
    now: Date,
    leaseExpiresAt: Date
  ): Promise<GmailSyncRunRecord> {
    try {
      return await this.database.$transaction(async (transaction) => {
        const run = await transaction.gmailSyncRun.findUnique({
          where: { userId_id: { userId, id: runId } }
        });
        if (!run) throw new ApiError(404, "SYNC_NOT_FOUND", "Gmail sync was not found");
        const mapped = mapRun(run);
        if (isTerminalStatus(mapped.status)) return mapped;
        if (mapped.cancelRequestedAt) {
          const cancelled = await transaction.gmailSyncRun.update({
            where: { userId_id: { userId, id: runId } },
            data: {
              status: DatabaseSyncStatus.cancelled,
              activeConnectionId: null,
              completedAt: now,
              leaseToken: null,
              leaseExpiresAt: null
            }
          });
          return mapRun(cancelled);
        }
        if (mapped.status === "running" && mapped.leaseExpiresAt && mapped.leaseExpiresAt > now) {
          throw new ApiError(409, "SYNC_STEP_IN_PROGRESS", "A Gmail sync step is already in progress");
        }
        const claimed = await transaction.gmailSyncRun.update({
          where: { userId_id: { userId, id: runId } },
          data: {
            status: DatabaseSyncStatus.running,
            leaseToken,
            leaseExpiresAt,
            safeErrorCode: null
          }
        });
        return mapRun(claimed);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error: unknown) {
      if (isPrismaCode(error, "P2034")) {
        throw new ApiError(409, "SYNC_STEP_IN_PROGRESS", "A Gmail sync step is already in progress");
      }
      throw error;
    }
  }

  public async getLeasedRun(
    userId: string,
    runId: string,
    leaseToken: string,
    leaseExpiresAt: Date
  ): Promise<GmailSyncRunRecord> {
    const updated = await this.database.gmailSyncRun.updateMany({
      where: { userId, id: runId, status: "running", leaseToken },
      data: { leaseExpiresAt }
    });
    if (updated.count !== 1) throw new ApiError(409, "SYNC_LEASE_LOST", "Gmail sync step lease expired");
    const run = await this.database.gmailSyncRun.findUnique({
      where: { userId_id: { userId, id: runId } }
    });
    if (!run) throw new ApiError(404, "SYNC_NOT_FOUND", "Gmail sync was not found");
    return mapRun(run);
  }

  public async stagePage(input: {
    userId: string;
    runId: string;
    leaseToken: string;
    messageIds: string[];
    nextPageToken: string | undefined;
    targetHistoryId: string | undefined;
    limitReached: boolean;
  }): Promise<GmailSyncRunRecord> {
    const uniqueIds = [...new Set(input.messageIds)];
    const updated = await this.database.gmailSyncRun.updateMany({
      where: { userId: input.userId, id: input.runId, status: "running", leaseToken: input.leaseToken },
      data: {
        pendingMessageIds: uniqueIds,
        nextPageToken: input.nextPageToken ?? null,
        targetHistoryId: input.targetHistoryId ?? null,
        listedCount: { increment: uniqueIds.length },
        limitReached: input.limitReached
      }
    });
    if (updated.count !== 1) throw new ApiError(409, "SYNC_LEASE_LOST", "Gmail sync step lease expired");
    const run = await this.getRun(input.userId, input.runId);
    if (!run) throw new ApiError(404, "SYNC_NOT_FOUND", "Gmail sync was not found");
    return run;
  }

  public async finishMessage(
    userId: string,
    runId: string,
    leaseToken: string,
    messageId: string,
    failed: boolean,
    safeErrorCode: string | undefined,
    now: Date,
    leaseExpiresAt: Date
  ): Promise<GmailSyncRunRecord> {
    return this.database.$transaction(async (transaction) => {
      const run = await transaction.gmailSyncRun.findUnique({
        where: { userId_id: { userId, id: runId } }
      });
      if (!run || run.status !== "running" || run.leaseToken !== leaseToken) {
        throw new ApiError(409, "SYNC_LEASE_LOST", "Gmail sync step lease expired");
      }
      const pendingIds = parsePendingIds(run.pendingMessageIds);
      if (pendingIds[0] !== messageId) throw new ApiError(409, "SYNC_STATE_CHANGED", "Gmail sync queue changed");
      const updated = await transaction.gmailSyncRun.update({
        where: { userId_id: { userId, id: runId } },
        data: {
          pendingMessageIds: pendingIds.slice(1),
          processedCount: { increment: 1 },
          ...(failed ? { failedCount: { increment: 1 } } : {}),
          ...(safeErrorCode ? { safeErrorCode } : {}),
          leaseExpiresAt
        }
      });
      return mapRun(updated);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  public async finishStep(userId: string, runId: string, leaseToken: string, now: Date): Promise<GmailSyncRunRecord> {
    return this.database.$transaction(async (transaction) => {
      const run = await transaction.gmailSyncRun.findUnique({
        where: { userId_id: { userId, id: runId } }
      });
      if (!run || run.status !== "running" || run.leaseToken !== leaseToken) {
        throw new ApiError(409, "SYNC_LEASE_LOST", "Gmail sync step lease expired");
      }
      const pendingIds = parsePendingIds(run.pendingMessageIds);
      if (run.cancelRequestedAt) {
        const cancelled = await transaction.gmailSyncRun.update({
          where: { userId_id: { userId, id: runId } },
          data: {
            status: DatabaseSyncStatus.cancelled,
            activeConnectionId: null,
            completedAt: now,
            leaseToken: null,
            leaseExpiresAt: null
          }
        });
        return mapRun(cancelled);
      }
      if (pendingIds.length > 0) {
        const pending = await transaction.gmailSyncRun.update({
          where: { userId_id: { userId, id: runId } },
          data: { status: DatabaseSyncStatus.pending, leaseToken: null, leaseExpiresAt: null }
        });
        return mapRun(pending);
      }
      if (run.nextPageToken && !run.limitReached) {
        const nextPage = await transaction.gmailSyncRun.update({
          where: { userId_id: { userId, id: runId } },
          data: {
            status: DatabaseSyncStatus.pending,
            pageToken: run.nextPageToken,
            nextPageToken: null,
            targetHistoryId: null,
            leaseToken: null,
            leaseExpiresAt: null
          }
        });
        return mapRun(nextPage);
      }

      if (run.failedCount > 0) {
        const failed = await transaction.gmailSyncRun.update({
          where: { userId_id: { userId, id: runId } },
          data: {
            status: DatabaseSyncStatus.failed,
            activeConnectionId: null,
            safeErrorCode: run.safeErrorCode ?? "SYNC_MESSAGES_FAILED",
            completedAt: now,
            leaseToken: null,
            leaseExpiresAt: null
          }
        });
        return mapRun(failed);
      }

      const cursor = run.mode === DatabaseSyncMode.initial ? run.startHistoryId : run.targetHistoryId;
      if (!cursor) throw new ApiError(500, "SYNC_CURSOR_MISSING", "Gmail sync could not commit its history cursor");
      const connectionUpdate = await transaction.googleConnection.updateMany({
        where: { id: run.googleConnectionId, userId, status: "active" },
        data: {
          gmailHistoryId: cursor,
          lastSuccessfulSyncAt: now,
          ...(run.mode === DatabaseSyncMode.initial ? { initialSyncCompletedAt: now } : {})
        }
      });
      if (connectionUpdate.count !== 1) {
        throw new ApiError(404, "GMAIL_CONNECTION_NOT_FOUND", "Connected Gmail account was not found");
      }
      const completed = await transaction.gmailSyncRun.update({
        where: { userId_id: { userId, id: runId } },
        data: {
          status: DatabaseSyncStatus.completed,
          activeConnectionId: null,
          completedAt: now,
          leaseToken: null,
          leaseExpiresAt: null
        }
      });
      return mapRun(completed);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  public async releasePartial(
    userId: string,
    runId: string,
    leaseToken: string,
    safeErrorCode: string
  ): Promise<GmailSyncRunRecord> {
    return this.updateLeasedRun(userId, runId, leaseToken, {
      status: DatabaseSyncStatus.partial,
      safeErrorCode,
      leaseToken: null,
      leaseExpiresAt: null
    });
  }

  public async failRun(
    userId: string,
    runId: string,
    leaseToken: string,
    safeErrorCode: string,
    now: Date
  ): Promise<GmailSyncRunRecord> {
    return this.updateLeasedRun(userId, runId, leaseToken, {
      status: DatabaseSyncStatus.failed,
      activeConnectionId: null,
      safeErrorCode,
      completedAt: now,
      leaseToken: null,
      leaseExpiresAt: null
    });
  }

  public async failAfterQueueRetries(
    userId: string,
    runId: string,
    safeErrorCode: string,
    now: Date
  ): Promise<GmailSyncRunRecord> {
    return this.database.$transaction(async (transaction) => {
      const current = await transaction.gmailSyncRun.findUnique({ where: { userId_id: { userId, id: runId } } });
      if (!current) throw new ApiError(404, "SYNC_NOT_FOUND", "Gmail sync was not found");
      if (isTerminalStatus(mapRun(current).status)) return mapRun(current);

      const cancelled = current.cancelRequestedAt !== null;
      const updated = await transaction.gmailSyncRun.updateMany({
        where: {
          userId,
          id: runId,
          status: { in: [DatabaseSyncStatus.pending, DatabaseSyncStatus.running, DatabaseSyncStatus.partial] }
        },
        data: {
          status: cancelled ? DatabaseSyncStatus.cancelled : DatabaseSyncStatus.failed,
          activeConnectionId: null,
          safeErrorCode: cancelled ? current.safeErrorCode : safeErrorCode,
          completedAt: now,
          leaseToken: null,
          leaseExpiresAt: null
        }
      });
      const run = await transaction.gmailSyncRun.findUnique({ where: { userId_id: { userId, id: runId } } });
      if (!run || updated.count === 0 && !isTerminalStatus(mapRun(run).status)) {
        throw new ApiError(409, "SYNC_STATE_CHANGED", "Gmail sync state changed while recovering the job");
      }
      return mapRun(run);
    });
  }

  public async requireResync(
    userId: string,
    runId: string,
    leaseToken: string,
    now: Date
  ): Promise<GmailSyncRunRecord> {
    return this.updateLeasedRun(userId, runId, leaseToken, {
      status: DatabaseSyncStatus.resync_required,
      activeConnectionId: null,
      safeErrorCode: "HISTORY_CURSOR_EXPIRED",
      completedAt: now,
      leaseToken: null,
      leaseExpiresAt: null
    });
  }

  public async requestCancellation(userId: string, runId: string, now: Date): Promise<GmailSyncRunRecord | null> {
    return this.database.$transaction(async (transaction) => {
      const run = await transaction.gmailSyncRun.findUnique({
        where: { userId_id: { userId, id: runId } }
      });
      if (!run) return null;
      if (isTerminalStatus(mapRun(run).status)) return mapRun(run);
      if (run.status === DatabaseSyncStatus.running) {
        const cancelling = await transaction.gmailSyncRun.update({
          where: { userId_id: { userId, id: runId } },
          data: { cancelRequestedAt: now }
        });
        return mapRun(cancelling);
      }
      const cancelled = await transaction.gmailSyncRun.update({
        where: { userId_id: { userId, id: runId } },
        data: {
          status: DatabaseSyncStatus.cancelled,
          activeConnectionId: null,
          cancelRequestedAt: now,
          completedAt: now
        }
      });
      return mapRun(cancelled);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  public async cancelActiveForConnection(userId: string, googleConnectionId: string, now: Date): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.gmailSyncRun.updateMany({
        where: { userId, activeConnectionId: googleConnectionId, status: DatabaseSyncStatus.running },
        data: { cancelRequestedAt: now }
      });
      await transaction.gmailSyncRun.updateMany({
        where: {
          userId,
          activeConnectionId: googleConnectionId,
          status: { in: [DatabaseSyncStatus.pending, DatabaseSyncStatus.partial] }
        },
        data: {
          status: DatabaseSyncStatus.cancelled,
          activeConnectionId: null,
          cancelRequestedAt: now,
          completedAt: now
        }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async updateLeasedRun(
    userId: string,
    runId: string,
    leaseToken: string,
    data: Prisma.GmailSyncRunUpdateInput
  ): Promise<GmailSyncRunRecord> {
    const updated = await this.database.gmailSyncRun.updateMany({
      where: { userId, id: runId, status: DatabaseSyncStatus.running, leaseToken },
      data
    });
    if (updated.count !== 1) throw new ApiError(409, "SYNC_LEASE_LOST", "Gmail sync step lease expired");
    const run = await this.getRun(userId, runId);
    if (!run) throw new ApiError(404, "SYNC_NOT_FOUND", "Gmail sync was not found");
    return run;
  }
}

function mapRun(run: DatabaseSyncRun): GmailSyncRunRecord {
  return {
    id: run.id,
    userId: run.userId,
    googleConnectionId: run.googleConnectionId,
    mode: run.mode,
    status: run.status,
    startHistoryId: run.startHistoryId,
    targetHistoryId: run.targetHistoryId,
    pageToken: run.pageToken,
    nextPageToken: run.nextPageToken,
    pendingMessageIds: parsePendingIds(run.pendingMessageIds),
    maxMessages: run.maxMessages,
    listedCount: run.listedCount,
    processedCount: run.processedCount,
    failedCount: run.failedCount,
    limitReached: run.limitReached,
    cancelRequestedAt: run.cancelRequestedAt,
    leaseToken: run.leaseToken,
    leaseExpiresAt: run.leaseExpiresAt,
    safeErrorCode: run.safeErrorCode,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  };
}

function parsePendingIds(value: Prisma.JsonValue): string[] {
  const parsed = PendingMessageIdsSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(500, "SYNC_STATE_INVALID", "Gmail sync state is invalid");
  return parsed.data;
}

function isTerminalStatus(status: GmailSyncStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "resync_required" || status === "failed";
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
