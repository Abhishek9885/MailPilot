import { randomUUID } from "node:crypto";
import { UnrecoverableError, Worker, Queue, type Job } from "bullmq";
import { Redis } from "ioredis";
import { prisma } from "../database.js";
import { apiEnvironment } from "../environment.js";
import { logger } from "../logger.js";
import { createGmailSyncService } from "../gmail/runtime.js";
import { FollowUpService } from "../followups/service.js";
import { withBoundedRetry } from "../followups/scheduling.js";
import type { GmailSyncProgress } from "@mailpilot/shared";
import {
  GmailSyncJobSchema,
  FollowUpScanJobSchema,
  FOLLOW_UP_SCAN_JOB_NAME,
  FOLLOW_UP_SCAN_QUEUE,
  GMAIL_SYNC_JOB_NAME,
  GMAIL_SYNC_QUEUE,
  followUpScanQueueJobId,
  gmailSyncQueueJobId,
  WORKER_HEARTBEAT_PREFIX,
  type GmailSyncJobPayload,
  type FollowUpScanJobPayload
} from "./contracts.js";
import { FOLLOW_UP_SCAN_JOB_OPTIONS, GMAIL_SYNC_BATCHES_PER_ATTEMPT, GMAIL_SYNC_JOB_OPTIONS } from "./queue-options.js";
import { startOutboxRelay } from "./outbox-relay.js";

const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
const WORKER_HEARTBEAT_TTL_SECONDS = 45;
const WORKER_CONCURRENCY = 2;
const FOLLOW_UP_SCAN_WINDOW_MS = 15 * 60 * 1_000;
const FOLLOW_UP_SCHEDULER_INTERVAL_MS = 60_000;
const workerId = randomUUID();
const heartbeatKey = `${WORKER_HEARTBEAT_PREFIX}${workerId}`;
const syncService = createGmailSyncService(logger);
const followUpService = new FollowUpService(prisma);

const workerRedis = new Redis(apiEnvironment.REDIS_URL, { maxRetriesPerRequest: null });
const syncProducerRedis = new Redis(apiEnvironment.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false
});
const heartbeatRedis = new Redis(apiEnvironment.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false
});
const followUpWorkerRedis = new Redis(apiEnvironment.REDIS_URL, { maxRetriesPerRequest: null });
const followUpProducerRedis = new Redis(apiEnvironment.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false
});
for (const client of [workerRedis, syncProducerRedis, heartbeatRedis, followUpWorkerRedis, followUpProducerRedis]) {
  client.on("error", (error: unknown) => {
    logger.warn({ errorType: error instanceof Error ? error.name : "RedisError" }, "jobs.redis_connection_error");
  });
}

const syncQueue = new Queue<GmailSyncJobPayload>(GMAIL_SYNC_QUEUE, { connection: syncProducerRedis });
syncQueue.on("error", (error: Error) => {
  logger.error({ errorType: error.name }, "jobs.queue_error");
});
const followUpQueue = new Queue<FollowUpScanJobPayload>(FOLLOW_UP_SCAN_QUEUE, { connection: followUpProducerRedis });
followUpQueue.on("error", (error: Error) => {
  logger.error({ errorType: error.name }, "jobs.followup_queue_error");
});

const worker = new Worker<GmailSyncJobPayload>(
  GMAIL_SYNC_QUEUE,
  async (job) => processGmailSyncJob(job),
  {
    connection: workerRedis,
    concurrency: WORKER_CONCURRENCY,
    autorun: true
  }
);
const followUpWorker = new Worker<FollowUpScanJobPayload>(
  FOLLOW_UP_SCAN_QUEUE,
  async (job) => processFollowUpScanJob(job),
  { connection: followUpWorkerRedis, concurrency: 2, autorun: true }
);

const stopOutboxRelay = startOutboxRelay(prisma, syncQueue, logger);
const stopFollowUpScheduler = startFollowUpScheduler();
let heartbeatTimer: NodeJS.Timeout | null = null;
let shuttingDown: Promise<void> | null = null;

worker.on("ready", () => {
  void updateHeartbeat();
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => { void updateHeartbeat(); }, WORKER_HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();
  }
  logger.info({ queue: GMAIL_SYNC_QUEUE }, "jobs.worker_ready");
});
worker.on("completed", (job) => {
  logger.info({ requestId: readRequestId(job.data), jobType: "gmail.sync" }, "jobs.completed");
});
worker.on("failed", (job, error) => {
  if (!job) return;
  logger.warn({
    requestId: readRequestId(job.data),
    jobType: "gmail.sync",
    attempt: job.attemptsMade,
    errorType: error.name
  }, "jobs.attempt_failed");
  const maxAttempts = job.opts.attempts ?? GMAIL_SYNC_JOB_OPTIONS.attempts;
  if (error instanceof UnrecoverableError || job.attemptsMade >= maxAttempts) void handleExhaustedJob(job);
});
worker.on("error", (error) => {
  logger.error({ errorType: error.name }, "jobs.worker_error");
});
followUpWorker.on("ready", () => logger.info({ queue: FOLLOW_UP_SCAN_QUEUE }, "jobs.worker_ready"));
followUpWorker.on("completed", (job) => {
  logger.info({ requestId: job.data.requestId, jobType: FOLLOW_UP_SCAN_JOB_NAME }, "jobs.completed");
});
followUpWorker.on("failed", (job, error) => {
  if (!job) return;
  logger.warn({
    requestId: readFollowUpRequestId(job.data),
    jobType: FOLLOW_UP_SCAN_JOB_NAME,
    attempt: job.attemptsMade,
    errorType: error.name
  }, "jobs.attempt_failed");
});
followUpWorker.on("error", (error) => {
  logger.error({ errorType: error.name }, "jobs.followup_worker_error");
});

logger.info({ queue: GMAIL_SYNC_QUEUE, concurrency: WORKER_CONCURRENCY }, "jobs.worker_started");
logger.info({ queue: FOLLOW_UP_SCAN_QUEUE, concurrency: 2 }, "jobs.worker_started");

async function processGmailSyncJob(job: Job<GmailSyncJobPayload>): Promise<{ status: GmailSyncProgress["status"] }> {
  const parsed = GmailSyncJobSchema.safeParse(job.data);
  if (!parsed.success || job.name !== GMAIL_SYNC_JOB_NAME || job.id !== gmailSyncQueueJobId(parsed.success ? parsed.data.syncId : "invalid")) {
    throw new UnrecoverableError("Invalid Gmail sync job payload");
  }

  for (let batch = 0; batch < GMAIL_SYNC_BATCHES_PER_ATTEMPT; batch += 1) {
    const progress = await syncService.processNextBatch(parsed.data.userId, parsed.data.syncId);
    if (isTerminal(progress.status)) return { status: progress.status };
    if (progress.status === "partial") {
      throw new RetryableSyncError(progress.safeErrorCode ?? "SYNC_RETRYABLE_FAILURE");
    }
  }

  const progress = await syncService.getProgress(parsed.data.userId, parsed.data.syncId);
  if (isTerminal(progress.status)) return { status: progress.status };
  throw new RetryableSyncError("SYNC_BATCH_BUDGET_REACHED");
}

async function processFollowUpScanJob(job: Job<FollowUpScanJobPayload>): Promise<{ created: number; cancelled: number }> {
  const parsed = FollowUpScanJobSchema.safeParse(job.data);
  if (!parsed.success || job.name !== FOLLOW_UP_SCAN_JOB_NAME
      || job.id !== followUpScanQueueJobId(parsed.success ? parsed.data.userId : "invalid", parsed.success ? parsed.data.windowId : 0)) {
    throw new UnrecoverableError("Invalid follow-up scan payload");
  }
  return withBoundedRetry(() => followUpService.scanUser(parsed.data.userId), {
    attempts: 2,
    baseDelayMs: 250,
    maxDelayMs: 500,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  });
}

function startFollowUpScheduler(): () => Promise<void> {
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const enqueue = (): void => {
    if (stopped || inFlight) return;
    const windowId = Math.floor(Date.now() / FOLLOW_UP_SCAN_WINDOW_MS);
    inFlight = followUpService.listEnabledUserIds().then(async (userIds) => {
      for (const userId of userIds) {
        const requestId = randomUUID();
        const payload: FollowUpScanJobPayload = { type: "followups.scan", userId, windowId, requestId };
        await followUpQueue.add(FOLLOW_UP_SCAN_JOB_NAME, payload, {
          ...FOLLOW_UP_SCAN_JOB_OPTIONS,
          jobId: followUpScanQueueJobId(userId, windowId)
        });
      }
    }).catch((error: unknown) => {
      logger.warn({
        jobType: FOLLOW_UP_SCAN_JOB_NAME,
        errorType: error instanceof Error ? error.name : "UnknownError"
      }, "jobs.followup_schedule_failed");
    }).finally(() => { inFlight = null; });
  };
  enqueue();
  const timer = setInterval(enqueue, FOLLOW_UP_SCHEDULER_INTERVAL_MS);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}

async function handleExhaustedJob(job: Job<GmailSyncJobPayload>): Promise<void> {
  const parsed = GmailSyncJobSchema.safeParse(job.data);
  if (!parsed.success || job.name !== GMAIL_SYNC_JOB_NAME || job.id !== gmailSyncQueueJobId(parsed.success ? parsed.data.syncId : "invalid")) {
    const syncId = !parsed.success ? /^gmail-sync-([0-9a-f-]{36})$/i.exec(job.id ?? "")?.[1] : undefined;
    if (syncId) {
      await prisma.jobOutboxEvent.updateMany({
        where: { aggregateId: syncId, status: "dispatched" },
        data: {
          status: "dead_letter",
          safeErrorCode: "JOB_PAYLOAD_INVALID",
          failureAttempts: Math.max(1, job.attemptsMade),
          failedAt: new Date()
        }
      }).catch(() => undefined);
    }
    logger.error({ jobType: "gmail.sync", safeErrorCode: "JOB_PAYLOAD_INVALID" }, "jobs.dead_lettered");
    return;
  }

  const safeErrorCode = job.failedReason === "Invalid Gmail sync job payload"
    ? "JOB_PAYLOAD_INVALID"
    : parseSafeErrorCode(job.failedReason);
  try {
    const progress = await syncService.failAfterQueueRetries(parsed.data.userId, parsed.data.syncId, safeErrorCode);
    if (progress.status !== "failed") {
      logger.warn({
        requestId: parsed.data.requestId,
        jobType: "gmail.sync",
        terminalStatus: progress.status
      }, "jobs.exhausted_after_sync_terminal");
      return;
    }
    await prisma.jobOutboxEvent.updateMany({
      where: {
        userId: parsed.data.userId,
        aggregateId: parsed.data.syncId,
        jobType: "gmail_sync",
        status: "dispatched"
      },
      data: {
        status: "dead_letter",
        safeErrorCode,
        failureAttempts: job.attemptsMade,
        failedAt: new Date()
      }
    });
    logger.error({
      requestId: parsed.data.requestId,
      jobType: "gmail.sync",
      attempt: job.attemptsMade,
      safeErrorCode
    }, "jobs.dead_lettered");
  } catch (error: unknown) {
    logger.error({
      requestId: parsed.data.requestId,
      jobType: "gmail.sync",
      safeErrorCode: "DEAD_LETTER_PERSIST_FAILED",
      errorType: error instanceof Error ? error.name : "UnknownError"
    }, "jobs.dead_letter_persist_failed");
  }
}

async function updateHeartbeat(): Promise<void> {
  try {
    if (workerRedis.status !== "ready") throw new Error("Worker Redis connection is not ready");
    await heartbeatRedis.set(heartbeatKey, Date.now().toString(), "EX", WORKER_HEARTBEAT_TTL_SECONDS);
  } catch {
    logger.warn({ workerId }, "jobs.heartbeat_failed");
  }
}

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    logger.info({ reason }, "jobs.worker_shutdown_started");
    const forceExit = setTimeout(() => {
      logger.fatal({ reason }, "jobs.worker_shutdown_timeout");
      process.exit(1);
    }, 15_000);
    forceExit.unref();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await shutdownStep("outbox_relay", stopOutboxRelay);
    await shutdownStep("followup_scheduler", stopFollowUpScheduler);
    await heartbeatRedis.del(heartbeatKey).catch(() => undefined);
    await shutdownStep("worker", () => worker.close());
    await shutdownStep("followup_worker", () => followUpWorker.close());
    await shutdownStep("sync_queue", () => syncQueue.close());
    await shutdownStep("followup_queue", () => followUpQueue.close());
    await shutdownStep("heartbeat_redis", () => safeQuit(heartbeatRedis));
    await shutdownStep("producer_redis", () => safeQuit(syncProducerRedis));
    await shutdownStep("followup_producer_redis", () => safeQuit(followUpProducerRedis));
    await shutdownStep("worker_redis", () => safeQuit(workerRedis));
    await shutdownStep("followup_worker_redis", () => safeQuit(followUpWorkerRedis));
    await shutdownStep("database", () => prisma.$disconnect());
    clearTimeout(forceExit);
    process.exitCode = exitCode;
    logger.info({ reason }, "jobs.worker_shutdown_completed");
  })();
  return shuttingDown;
}

async function shutdownStep(name: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error: unknown) {
    logger.warn({ resource: name, errorType: error instanceof Error ? error.name : "UnknownError" }, "jobs.shutdown_step_failed");
  }
}

async function safeQuit(redis: Redis): Promise<void> {
  if (redis.status === "end") return;
  if (redis.status === "wait") {
    redis.disconnect();
    return;
  }
  await redis.quit().catch(() => { redis.disconnect(); });
}

function isTerminal(status: GmailSyncProgress["status"]): boolean {
  return status === "completed" || status === "cancelled" || status === "resync_required" || status === "failed";
}

function readRequestId(value: unknown): string | undefined {
  const parsed = GmailSyncJobSchema.safeParse(value);
  return parsed.success ? parsed.data.requestId : undefined;
}

function readFollowUpRequestId(value: unknown): string | undefined {
  const parsed = FollowUpScanJobSchema.safeParse(value);
  return parsed.success ? parsed.data.requestId : undefined;
}

function parseSafeErrorCode(value: string | undefined): string {
  if (!value) return "SYNC_RETRIES_EXHAUSTED";
  if (value === "SYNC_BATCH_BUDGET_REACHED") return value;
  const match = /^([A-Z][A-Z0-9_]{0,127})$/.exec(value);
  return match?.[1] ?? "SYNC_RETRIES_EXHAUSTED";
}

class RetryableSyncError extends Error {
  public constructor(safeErrorCode: string) {
    super(safeErrorCode);
    this.name = "RetryableSyncError";
  }
}

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("uncaughtException", (error) => {
  logger.fatal({ errorType: error.name }, "jobs.worker_uncaught_exception");
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  logger.fatal({ reasonType: reason instanceof Error ? reason.name : typeof reason }, "jobs.worker_unhandled_rejection");
  void shutdown("unhandledRejection", 1);
});
