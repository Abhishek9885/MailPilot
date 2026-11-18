-- CreateEnum
CREATE TYPE "app"."google_connection_status" AS ENUM ('active', 'reauth_required', 'disconnected');

-- CreateEnum
CREATE TYPE "app"."analysis_status" AS ENUM ('queued', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "app"."email_chunk_status" AS ENUM ('active', 'deleted');

-- CreateEnum
CREATE TYPE "app"."agent_run_status" AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "app"."pending_action_status" AS ENUM ('pending', 'approved', 'rejected', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "app"."task_status" AS ENUM ('pending_review', 'active', 'completed', 'dismissed');

-- CreateEnum
CREATE TYPE "app"."follow_up_status" AS ENUM ('planned', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "app"."audit_actor_type" AS ENUM ('user', 'system', 'agent', 'administrator');

-- CreateTable
CREATE TABLE "app"."authentication_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "provider_subject" VARCHAR(255) NOT NULL,
    "email_normalized" VARCHAR(320),
    "email_verified_at" TIMESTAMPTZ(6),
    "last_authenticated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "authentication_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "csrf_token_hash" CHAR(64),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."google_connections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider_subject" VARCHAR(255) NOT NULL,
    "provider_email_normalized" VARCHAR(320) NOT NULL,
    "status" "app"."google_connection_status" NOT NULL DEFAULT 'active',
    "granted_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnected_at" TIMESTAMPTZ(6),
    "last_successful_sync_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "google_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."emails" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "google_connection_id" UUID NOT NULL,
    "provider_message_id" VARCHAR(255) NOT NULL,
    "provider_thread_id" VARCHAR(255) NOT NULL,
    "sender_email_normalized" VARCHAR(320) NOT NULL,
    "subject" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "body_hash" CHAR(64) NOT NULL,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "source_revision" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."analyses" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email_id" UUID NOT NULL,
    "source_revision" INTEGER NOT NULL,
    "schema_version" VARCHAR(64) NOT NULL,
    "model_version" VARCHAR(128) NOT NULL,
    "status" "app"."analysis_status" NOT NULL DEFAULT 'queued',
    "result" JSONB,
    "safe_error_code" VARCHAR(128),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."email_chunks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email_id" UUID NOT NULL,
    "source_revision" INTEGER NOT NULL,
    "chunker_version" VARCHAR(64) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "start_char" INTEGER NOT NULL,
    "end_char" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "status" "app"."email_chunk_status" NOT NULL DEFAULT 'active',
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."agent_runs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "google_connection_id" UUID,
    "request_reference" VARCHAR(128) NOT NULL,
    "intent" VARCHAR(64) NOT NULL,
    "status" "app"."agent_run_status" NOT NULL DEFAULT 'queued',
    "graph_version" VARCHAR(64) NOT NULL,
    "checkpoint_thread_id" VARCHAR(255),
    "provider" VARCHAR(64),
    "model_version" VARCHAR(128),
    "latency_ms" INTEGER,
    "estimated_cost" DECIMAL(12,6),
    "safe_error_code" VARCHAR(128),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."pending_actions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "agent_run_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "action_type" VARCHAR(64) NOT NULL,
    "canonical_payload" JSONB NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "payload_version" INTEGER NOT NULL DEFAULT 1,
    "status" "app"."pending_action_status" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pending_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."tasks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "agent_run_id" UUID,
    "source_email_id" UUID,
    "title" VARCHAR(500) NOT NULL,
    "description" TEXT,
    "due_at" TIMESTAMPTZ(6),
    "due_timezone" VARCHAR(128),
    "confidence" DOUBLE PRECISION,
    "status" "app"."task_status" NOT NULL DEFAULT 'pending_review',
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."follow_ups" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email_id" UUID NOT NULL,
    "task_id" UUID,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "app"."follow_up_status" NOT NULL DEFAULT 'planned',
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "actor_type" "app"."audit_actor_type" NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "entity_type" VARCHAR(64),
    "entity_id" VARCHAR(128),
    "request_id" VARCHAR(128),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "authentication_identities_user_provider_idx" ON "app"."authentication_identities"("user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "authentication_identities_provider_subject_key" ON "app"."authentication_identities"("provider", "provider_subject");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "app"."sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_expires_at_idx" ON "app"."sessions"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "app"."sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "google_connections_provider_subject_key" ON "app"."google_connections"("provider_subject");

-- CreateIndex
CREATE INDEX "google_connections_user_status_idx" ON "app"."google_connections"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "google_connections_user_id_id_key" ON "app"."google_connections"("user_id", "id");

-- CreateIndex
CREATE INDEX "emails_user_received_at_idx" ON "app"."emails"("user_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "emails_connection_thread_received_idx" ON "app"."emails"("google_connection_id", "provider_thread_id", "received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "emails_connection_provider_message_key" ON "app"."emails"("google_connection_id", "provider_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "emails_user_id_id_key" ON "app"."emails"("user_id", "id");

-- CreateIndex
CREATE INDEX "analyses_user_status_created_idx" ON "app"."analyses"("user_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "analyses_email_revision_idx" ON "app"."analyses"("email_id", "source_revision");

-- CreateIndex
CREATE UNIQUE INDEX "analyses_email_revision_schema_model_key" ON "app"."analyses"("email_id", "source_revision", "schema_version", "model_version");

-- CreateIndex
CREATE INDEX "email_chunks_user_email_status_idx" ON "app"."email_chunks"("user_id", "email_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "email_chunks_source_ordinal_key" ON "app"."email_chunks"("email_id", "source_revision", "chunker_version", "ordinal");

-- CreateIndex
CREATE INDEX "agent_runs_user_status_created_idx" ON "app"."agent_runs"("user_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_user_id_id_key" ON "app"."agent_runs"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_user_request_reference_key" ON "app"."agent_runs"("user_id", "request_reference");

-- CreateIndex
CREATE INDEX "pending_actions_user_status_expires_idx" ON "app"."pending_actions"("user_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "pending_actions_user_run_idx" ON "app"."pending_actions"("user_id", "agent_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "pending_actions_user_idempotency_key" ON "app"."pending_actions"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "tasks_user_status_due_at_idx" ON "app"."tasks"("user_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "tasks_user_run_idx" ON "app"."tasks"("user_id", "agent_run_id");

-- CreateIndex
CREATE INDEX "tasks_user_source_email_idx" ON "app"."tasks"("user_id", "source_email_id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_user_id_id_key" ON "app"."tasks"("user_id", "id");

-- CreateIndex
CREATE INDEX "follow_ups_user_status_schedule_idx" ON "app"."follow_ups"("user_id", "status", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "follow_ups_email_schedule_key" ON "app"."follow_ups"("email_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "audit_logs_user_created_idx" ON "app"."audit_logs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_entity_created_idx" ON "app"."audit_logs"("entity_type", "entity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_request_id_idx" ON "app"."audit_logs"("request_id");

-- AddForeignKey
ALTER TABLE "app"."authentication_identities" ADD CONSTRAINT "authentication_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."google_connections" ADD CONSTRAINT "google_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."emails" ADD CONSTRAINT "emails_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."emails" ADD CONSTRAINT "emails_user_id_google_connection_id_fkey" FOREIGN KEY ("user_id", "google_connection_id") REFERENCES "app"."google_connections"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."analyses" ADD CONSTRAINT "analyses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."analyses" ADD CONSTRAINT "analyses_user_id_email_id_fkey" FOREIGN KEY ("user_id", "email_id") REFERENCES "app"."emails"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."email_chunks" ADD CONSTRAINT "email_chunks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."email_chunks" ADD CONSTRAINT "email_chunks_user_id_email_id_fkey" FOREIGN KEY ("user_id", "email_id") REFERENCES "app"."emails"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."agent_runs" ADD CONSTRAINT "agent_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."agent_runs" ADD CONSTRAINT "agent_runs_user_id_google_connection_id_fkey" FOREIGN KEY ("user_id", "google_connection_id") REFERENCES "app"."google_connections"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."pending_actions" ADD CONSTRAINT "pending_actions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."pending_actions" ADD CONSTRAINT "pending_actions_user_id_agent_run_id_fkey" FOREIGN KEY ("user_id", "agent_run_id") REFERENCES "app"."agent_runs"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_user_id_agent_run_id_fkey" FOREIGN KEY ("user_id", "agent_run_id") REFERENCES "app"."agent_runs"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_user_id_source_email_id_fkey" FOREIGN KEY ("user_id", "source_email_id") REFERENCES "app"."emails"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."follow_ups" ADD CONSTRAINT "follow_ups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."follow_ups" ADD CONSTRAINT "follow_ups_user_id_email_id_fkey" FOREIGN KEY ("user_id", "email_id") REFERENCES "app"."emails"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."follow_ups" ADD CONSTRAINT "follow_ups_user_id_task_id_fkey" FOREIGN KEY ("user_id", "task_id") REFERENCES "app"."tasks"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CHECK constraints are not represented in the Prisma schema, so keep these in the migration.
ALTER TABLE "app"."sessions" ADD CONSTRAINT "sessions_expiry_after_creation_check" CHECK ("expires_at" > "created_at");
ALTER TABLE "app"."emails" ADD CONSTRAINT "emails_source_revision_positive_check" CHECK ("source_revision" > 0);
ALTER TABLE "app"."analyses" ADD CONSTRAINT "analyses_source_revision_positive_check" CHECK ("source_revision" > 0);
ALTER TABLE "app"."email_chunks" ADD CONSTRAINT "email_chunks_offsets_valid_check" CHECK ("source_revision" > 0 AND "ordinal" >= 0 AND "start_char" >= 0 AND "end_char" > "start_char");
ALTER TABLE "app"."agent_runs" ADD CONSTRAINT "agent_runs_metrics_nonnegative_check" CHECK (("latency_ms" IS NULL OR "latency_ms" >= 0) AND ("estimated_cost" IS NULL OR "estimated_cost" >= 0));
ALTER TABLE "app"."pending_actions" ADD CONSTRAINT "pending_actions_version_expiry_check" CHECK ("payload_version" > 0 AND "expires_at" > "created_at");
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_confidence_range_check" CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));
