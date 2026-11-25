import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import type { Logger } from "pino";
import { GmailSyncJobSchema, GMAIL_SYNC_JOB_NAME, type GmailSyncJobPayload } from "./contracts.js";
import { GMAIL_SYNC_JOB_OPTIONS } from "./queue-options.js";

const OUTBOX_MAX_ATTEMPTS = 12;
const OUTBOX_LEASE_MS = 30_000;
const OUTBOX_POLL_MS = 1_000;
const OUTBOX_BATCH_SIZE = 20;
const OUTBOX_SUCCESS_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const OUTBOX_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1_000;

type OutboxQueue = Pick<Queue<GmailSyncJobPayload>, "add">;
type OutboxEvent = Prisma.JobOutboxEventGetPayload<Record<string, never>>;

export function startOutboxRelay(
  database: PrismaClient,
  queue: OutboxQueue,
  logger: Logger
): () => Promise<void> {
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let cleanupInFlight: Promise<void> | null = null;

  const poll = (): void => {
    if (stopped || inFlight) return;
    inFlight = relayBatch(database, queue, logger)
      .catch(() => logger.error({ jobType: "gmail.sync" }, "jobs.outbox_poll_failed"))
      .finally(() => { inFlight = null; });
  };

  poll();
  const timer = setInterval(poll, OUTBOX_POLL_MS);
  timer.unref();
  const cleanupTimer = setInterval(() => {
    if (cleanupInFlight) return;
    cleanupInFlight = database.jobOutboxEvent.deleteMany({
      where: { status: "dispatched", dispatchedAt: { lt: new Date(Date.now() - OUTBOX_SUCCESS_RETENTION_MS) } }
    }).then(({ count }) => {
      if (count > 0) logger.info({ deletedCount: count }, "jobs.outbox_retention_applied");
    }).catch(() => logger.error({ jobType: "gmail.sync" }, "jobs.outbox_cleanup_failed"))
      .finally(() => { cleanupInFlight = null; });
  }, OUTBOX_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(cleanupTimer);
    await inFlight;
    await cleanupInFlight;
  };
}

async function relayBatch(database: PrismaClient, queue: OutboxQueue, logger: Logger): Promise<void> {
  const now = new Date();
  const candidates = await database.jobOutboxEvent.findMany({
    where: {
      OR: [
        { status: "pending", availableAt: { lte: now } },
        { status: "processing", OR: [{ leaseExpiresAt: { lte: now } }, { leaseExpiresAt: null }] }
      ]
    },
    orderBy: { createdAt: "asc" },
    take: OUTBOX_BATCH_SIZE
  });

  for (const candidate of candidates) {
    await dispatchOne(database, queue, candidate, logger, now);
  }
}

async function dispatchOne(
  database: PrismaClient,
  queue: OutboxQueue,
  candidate: OutboxEvent,
  logger: Logger,
  now: Date
): Promise<void> {
  const leaseToken = randomUUID();
  const candidateWhere = candidate.status === "processing"
    ? { id: candidate.id, status: "processing" as const, OR: [{ leaseExpiresAt: { lte: now } }, { leaseExpiresAt: null }] }
    : { id: candidate.id, status: "pending" as const, availableAt: { lte: now } };
  const claimed = await database.jobOutboxEvent.updateMany({
    where: candidateWhere,
    data: {
      status: "processing",
      attempts: { increment: 1 },
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + OUTBOX_LEASE_MS)
    }
  });
  if (claimed.count !== 1) return;

  const parsed = GmailSyncJobSchema.safeParse(candidate.payload);
  if (
    !parsed.success
    || candidate.jobType !== "gmail_sync"
    || (parsed.success && (parsed.data.syncId !== candidate.aggregateId || parsed.data.userId !== candidate.userId))
  ) {
    await markDeadLetter(database, candidate.id, leaseToken, "JOB_PAYLOAD_INVALID");
    logger.error({ requestId: parsed.success ? parsed.data.requestId : undefined, jobType: "gmail.sync" }, "jobs.outbox_dead_lettered");
    return;
  }

  let enqueued = false;
  try {
    await queue.add(GMAIL_SYNC_JOB_NAME, parsed.data, {
      ...GMAIL_SYNC_JOB_OPTIONS,
      jobId: `gmail-sync-${parsed.data.syncId}`
    });
    enqueued = true;
    await database.jobOutboxEvent.updateMany({
      where: { id: candidate.id, status: "processing", leaseToken },
      data: {
        status: "dispatched",
        dispatchedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        safeErrorCode: null
      }
    });
  } catch {
    if (enqueued) {
      logger.warn({ requestId: parsed.data.requestId, jobType: "gmail.sync" }, "jobs.outbox_dispatch_state_unknown");
      return;
    }
    const attempts = candidate.attempts + 1;
    const finalAttempt = attempts >= OUTBOX_MAX_ATTEMPTS;
    const baseBackoffMs = Math.min(60_000, 1_000 * (2 ** Math.min(attempts - 1, 6)));
    const backoffMs = Math.round(baseBackoffMs * (0.75 + Math.random() * 0.5));
    const updated = await database.jobOutboxEvent.updateMany({
      where: { id: candidate.id, status: "processing", leaseToken },
      data: {
        status: finalAttempt ? "dead_letter" : "pending",
        availableAt: new Date(Date.now() + backoffMs),
        leaseToken: null,
        leaseExpiresAt: null,
        safeErrorCode: "QUEUE_DISPATCH_FAILED",
        ...(finalAttempt ? { failedAt: new Date() } : {})
      }
    });
    if (updated.count === 1) {
      logger.error({
        requestId: parsed.data.requestId,
        jobType: "gmail.sync",
        attempt: attempts,
        safeErrorCode: "QUEUE_DISPATCH_FAILED"
      }, finalAttempt ? "jobs.outbox_dead_lettered" : "jobs.outbox_retry_scheduled");
    }
  }
}

async function markDeadLetter(
  database: PrismaClient,
  id: string,
  leaseToken: string,
  safeErrorCode: string
): Promise<void> {
  await database.jobOutboxEvent.updateMany({
    where: { id, status: "processing", leaseToken },
    data: { status: "dead_letter", safeErrorCode, failedAt: new Date(), leaseToken: null, leaseExpiresAt: null }
  });
}
