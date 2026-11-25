CREATE TYPE "app"."user_memory_mode" AS ENUM ('disabled', 'enabled', 'paused');
CREATE TYPE "app"."user_memory_type" AS ENUM ('preference', 'recurring_commitment', 'relevant_fact');
CREATE TYPE "app"."user_memory_source_kind" AS ENUM ('user_entered', 'email');
CREATE TYPE "app"."user_memory_status" AS ENUM ('active', 'stale', 'expired');
CREATE TYPE "app"."user_memory_confidence_basis" AS ENUM ('user_asserted', 'model_evidence');

CREATE TABLE "app"."user_memory_settings" (
    "user_id" UUID NOT NULL,
    "mode" "app"."user_memory_mode" NOT NULL DEFAULT 'disabled',
    "consent_version" VARCHAR(32),
    "consented_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "user_memory_settings_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "user_memory_settings_consent_check" CHECK (
      ("mode" IN ('enabled', 'paused') AND "consent_version" IS NOT NULL AND "consented_at" IS NOT NULL)
      OR ("mode" = 'disabled' AND "consent_version" IS NULL AND "consented_at" IS NULL)
    )
);

CREATE TABLE "app"."user_memories" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "app"."user_memory_type" NOT NULL,
    "key" VARCHAR(96) NOT NULL,
    "value" VARCHAR(300) NOT NULL,
    "recurrence" JSONB,
    "source_kind" "app"."user_memory_source_kind" NOT NULL,
    "source_email_id" UUID,
    "source_thread_id" VARCHAR(255),
    "source_revision" INTEGER,
    "source_observed_at" TIMESTAMPTZ(6),
    "confidence" DOUBLE PRECISION,
    "confidence_basis" "app"."user_memory_confidence_basis" NOT NULL DEFAULT 'user_asserted',
    "status" "app"."user_memory_status" NOT NULL DEFAULT 'active',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "consent_version" VARCHAR(32) NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_confirmed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "user_memories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_memories_key_normalized_check" CHECK ("key" = lower("key")),
    CONSTRAINT "user_memories_revision_positive_check" CHECK ("revision" > 0),
    CONSTRAINT "user_memories_source_check" CHECK (
      ("source_kind" = 'email' AND "source_email_id" IS NOT NULL AND "source_thread_id" IS NOT NULL
       AND "source_revision" > 0 AND "source_observed_at" IS NOT NULL)
      OR ("source_kind" = 'user_entered' AND "source_email_id" IS NULL AND "source_thread_id" IS NULL
       AND "source_revision" IS NULL AND "source_observed_at" IS NULL)
    ),
    CONSTRAINT "user_memories_recurrence_check" CHECK (
      ("type" = 'recurring_commitment' AND "recurrence" IS NOT NULL AND jsonb_typeof("recurrence") = 'object')
      OR ("type" <> 'recurring_commitment' AND "recurrence" IS NULL)
    ),
    CONSTRAINT "user_memories_confidence_check" CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1))
);

CREATE UNIQUE INDEX "user_memories_user_type_key_key"
    ON "app"."user_memories"("user_id", "type", "key");
CREATE UNIQUE INDEX "user_memories_user_id_id_key"
    ON "app"."user_memories"("user_id", "id");
CREATE INDEX "user_memories_user_status_expiry_idx"
    ON "app"."user_memories"("user_id", "status", "expires_at");
CREATE INDEX "user_memories_user_updated_idx"
    ON "app"."user_memories"("user_id", "updated_at" DESC);

ALTER TABLE "app"."user_memory_settings"
    ADD CONSTRAINT "user_memory_settings_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app"."user_memories"
    ADD CONSTRAINT "user_memories_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app"."user_memories"
    ADD CONSTRAINT "user_memories_user_id_source_email_id_fkey"
    FOREIGN KEY ("user_id", "source_email_id") REFERENCES "app"."emails"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
