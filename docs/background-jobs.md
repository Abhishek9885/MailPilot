# Node background jobs

## Boundaries

BullMQ is used for long-running Node work that should survive a browser disconnect or API restart. Gmail synchronization and proactive follow-up scans use separate queues and typed payloads. Express owns identity, OAuth credentials, authorization, and creation/cancellation of sync runs. A separate Node worker loads credentials through Express-owned stores and calls Gmail with the existing `gmail.readonly` grant. Email bodies, Gmail tokens, and provider responses are never placed in queue payloads or logs.

FastAPI remains behind the authenticated Express-to-AI HTTP client. Python does not import BullMQ contracts, connect to Redis, or depend on Node queue internals. If a future AI operation needs background execution, Express will define a service-level request/response boundary for it first.

## Current queues and payloads

| Queue | Purpose | Payload |
|---|---|---|
| `mailpilot-gmail-sync` | Resume a persisted initial or incremental Gmail sync | `{ type: "gmail.sync", userId, syncId, requestId }` |
| `mailpilot-followup-scan` | Scan one user for enabled in-app reminders | `{ type: "followups.scan", userId, windowId, requestId }` |

Both payload schemas reject extra fields. Stable job IDs (`gmail-sync-{syncId}` and `followups-{userId}-{windowId}`) make retries and repeated scheduler enqueues idempotent. User identity is always passed explicitly and each processor applies owner-scoped data access; a queue job ID is not authorization.

## Delivery and recovery

1. `POST /v1/syncs` creates the `GmailSyncRun` and `JobOutboxEvent` in one PostgreSQL transaction. The outbox is the delivery intent and PostgreSQL remains the system of record.
2. The Node worker claims due outbox rows using a 30-second lease and polls once per second. Queue-add failures retry at most 12 times with bounded exponential backoff (up to one minute). Exhausted or invalid outbox rows are marked `dead_letter` with a safe code.
3. BullMQ runs at concurrency 2. Each sync delivery processes at most 20 batches of 25 messages, then yields through a retry if the run still has work. Gmail API requests time out after 30 seconds; the existing client applies its bounded request retries. A job has six total attempts with exponential backoff from 2.5 seconds and jitter. The Gmail run's PostgreSQL message/page checkpoints and lease make re-delivery safe.
4. When all BullMQ attempts fail, the worker records a safe terminal error and failure attempt count in the associated PostgreSQL outbox row (`dead_letter`). BullMQ retains failed queue jobs for up to 30 days, capped at 50,000 jobs. Gmail sync is read-only; retrying never sends or modifies a message.
5. Redis uses AOF (`appendfsync everysec`) and `noeviction`. API readiness requires PostgreSQL, Redis, and a worker heartbeat with a 45-second TTL. Liveness does not depend on these services.

Worker shutdown stops outbox polling, waits for active jobs through `Worker.close()`, closes the queues and Redis clients, then disconnects Prisma. BullMQ recovers stalled work after an abrupt worker interruption; the worker handler tolerates duplicate deliveries.

## Local operation

```powershell
npm run db:up
npm run db:generate
npm run db:deploy
npm run dev:all
```

`npm run dev:all` launches the web app, API, Node worker, and FastAPI service. To run the worker alone, use `npm run dev:worker`. Inspect local infrastructure with `docker compose ps`, `docker compose logs -f redis`, and `docker compose logs -f db`. `http://localhost:4000/health/ready` returns `503` until both Redis and a worker heartbeat are available.

## Dead-letter handling

Dead letters contain IDs and safe error codes only. First inspect the API/worker logs and the failed sync's owner-scoped progress. If the worker delivery exhausted its retries, the sync is terminal; fix the underlying issue, then start a new sync from the UI. For a local outbox dispatch dead letter caused by Redis being unavailable, restart Redis and the worker, inspect the row, and only requeue it if its Gmail run is still pending or partial:

```sql
SELECT id, user_id, job_type, aggregate_id, attempts, failure_attempts, safe_error_code, failed_at
FROM app.job_outbox_events
WHERE status = 'dead_letter';

UPDATE app.job_outbox_events
SET status = 'pending', attempts = 0, failure_attempts = 0, available_at = now(), safe_error_code = NULL,
    dispatched_at = NULL, failed_at = NULL,
    lease_token = NULL, lease_expires_at = NULL
WHERE id = '<outbox-event-uuid>' AND status = 'dead_letter'
  AND safe_error_code = 'QUEUE_DISPATCH_FAILED'
  AND EXISTS (
    SELECT 1 FROM app.gmail_sync_runs AS sync_run
    WHERE sync_run.user_id = job_outbox_events.user_id
      AND sync_run.id = job_outbox_events.aggregate_id
      AND sync_run.status IN ('pending', 'partial')
  );
```

The relay uses the stable sync job ID, so replay does not create parallel copies when the original queue entry is still retained. Do not edit payloads or user IDs while requeuing.

Follow-up scans are enqueued once per enabled user and 15-minute UTC window. The worker scheduler checks users every minute; a Redis or enqueue failure is retried on the next check. Each scan job gets four BullMQ attempts with exponential backoff, and the scanner makes one short deterministic retry for transient database failures. Failed jobs are retained in BullMQ for operator inspection. Scans only inspect owner-scoped commitment/thread metadata and write in-app suggestion rows; they never call Gmail or Calendar write APIs. See [proactive follow-ups](proactive-followups.md) for schedule, quiet-hours, rate-limit, and cancellation rules.
