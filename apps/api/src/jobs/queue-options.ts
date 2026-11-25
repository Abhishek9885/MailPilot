export const GMAIL_SYNC_ATTEMPTS = 6;
export const GMAIL_SYNC_BACKOFF_MS = 2_500;
export const GMAIL_SYNC_BATCHES_PER_ATTEMPT = 20;

export const GMAIL_SYNC_JOB_OPTIONS = {
  attempts: GMAIL_SYNC_ATTEMPTS,
  backoff: { type: "exponential" as const, delay: GMAIL_SYNC_BACKOFF_MS, jitter: 0.25 },
  removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10_000 },
  removeOnFail: { age: 30 * 24 * 60 * 60, count: 50_000 }
};

export const FOLLOW_UP_SCAN_JOB_OPTIONS = {
  attempts: 4,
  backoff: { type: "exponential" as const, delay: 5_000, jitter: 0.25 },
  removeOnComplete: { age: 24 * 60 * 60, count: 20_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 20_000 }
};

