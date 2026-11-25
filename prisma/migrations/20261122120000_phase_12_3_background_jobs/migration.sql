CREATE TYPE "app"."background_job_type" AS ENUM ('gmail_sync');
CREATE TYPE "app"."job_outbox_status" AS ENUM ('pending', 'processing', 'dispatched', 'dead_letter');

CREATE TABLE "app"."job_outbox_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "job_type" "app"."background_job_type" NOT NULL,
    "idempotency_key" VARCHAR(191) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "app"."job_outbox_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failure_attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" VARCHAR(36),
    "lease_expires_at" TIMESTAMPTZ(6),
    "dispatched_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "safe_error_code" VARCHAR(128),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "job_outbox_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "job_outbox_attempts_nonnegative_check" CHECK ("attempts" >= 0 AND "failure_attempts" >= 0)
);

CREATE UNIQUE INDEX "job_outbox_user_idempotency_key"
    ON "app"."job_outbox_events"("user_id", "idempotency_key");
CREATE INDEX "job_outbox_user_aggregate_idx"
    ON "app"."job_outbox_events"("user_id", "aggregate_id");
CREATE INDEX "job_outbox_status_available_idx"
    ON "app"."job_outbox_events"("status", "available_at");
CREATE INDEX "job_outbox_user_created_idx"
    ON "app"."job_outbox_events"("user_id", "created_at" DESC);

ALTER TABLE "app"."job_outbox_events"
    ADD CONSTRAINT "job_outbox_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
