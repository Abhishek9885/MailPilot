CREATE TYPE "app"."gmail_sync_mode" AS ENUM ('initial', 'incremental');

CREATE TYPE "app"."gmail_sync_run_status" AS ENUM (
    'pending',
    'running',
    'partial',
    'completed',
    'cancelled',
    'resync_required',
    'failed'
);

ALTER TABLE "app"."google_connections"
    ADD COLUMN "gmail_history_id" VARCHAR(64),
    ADD COLUMN "initial_sync_completed_at" TIMESTAMPTZ(6);

CREATE TABLE "app"."gmail_sync_runs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "google_connection_id" UUID NOT NULL,
    "active_connection_id" UUID,
    "mode" "app"."gmail_sync_mode" NOT NULL,
    "status" "app"."gmail_sync_run_status" NOT NULL DEFAULT 'pending',
    "start_history_id" VARCHAR(64),
    "target_history_id" VARCHAR(64),
    "page_token" TEXT,
    "next_page_token" TEXT,
    "pending_message_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "max_messages" INTEGER NOT NULL DEFAULT 500,
    "listed_count" INTEGER NOT NULL DEFAULT 0,
    "processed_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "limit_reached" BOOLEAN NOT NULL DEFAULT false,
    "cancel_requested_at" TIMESTAMPTZ(6),
    "lease_token" VARCHAR(36),
    "lease_expires_at" TIMESTAMPTZ(6),
    "safe_error_code" VARCHAR(128),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "gmail_sync_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gmail_sync_runs_active_connection_key"
    ON "app"."gmail_sync_runs"("active_connection_id");
CREATE UNIQUE INDEX "gmail_sync_runs_user_id_id_key"
    ON "app"."gmail_sync_runs"("user_id", "id");
CREATE INDEX "gmail_sync_runs_user_created_idx"
    ON "app"."gmail_sync_runs"("user_id", "created_at" DESC);
CREATE INDEX "gmail_sync_runs_connection_status_idx"
    ON "app"."gmail_sync_runs"("google_connection_id", "status");

ALTER TABLE "app"."gmail_sync_runs"
    ADD CONSTRAINT "gmail_sync_runs_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app"."gmail_sync_runs"
    ADD CONSTRAINT "gmail_sync_runs_user_id_google_connection_id_fkey"
    FOREIGN KEY ("user_id", "google_connection_id")
    REFERENCES "app"."google_connections"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "app"."gmail_sync_runs"
    ADD CONSTRAINT "gmail_sync_runs_counts_nonnegative_check"
    CHECK ("listed_count" >= 0 AND "processed_count" >= 0 AND "failed_count" >= 0 AND "max_messages" > 0);
