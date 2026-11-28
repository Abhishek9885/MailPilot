ALTER TYPE "app"."task_status" ADD VALUE IF NOT EXISTS 'superseded';

CREATE TYPE "app"."task_assignee" AS ENUM ('user', 'sender', 'other', 'unknown');
CREATE TYPE "app"."commitment_speaker" AS ENUM ('sender', 'user', 'third_party', 'unknown');
CREATE TYPE "app"."commitment_status" AS ENUM (
    'pending_review',
    'active',
    'fulfilled',
    'withdrawn',
    'dismissed',
    'superseded'
);

ALTER TABLE "app"."tasks"
    ADD COLUMN "source_thread_id" VARCHAR(255),
    ADD COLUMN "source_connection_id" UUID,
    ADD COLUMN "source_revision" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "source_evidence" TEXT,
    ADD COLUMN "deduplication_key" CHAR(64),
    ADD COLUMN "assignee" "app"."task_assignee" NOT NULL DEFAULT 'unknown',
    ADD COLUMN "last_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "reviewed_at" TIMESTAMPTZ(6),
    ADD COLUMN "dismissed_at" TIMESTAMPTZ(6),
    ADD COLUMN "superseded_at" TIMESTAMPTZ(6);

UPDATE "app"."tasks" SET "last_observed_at" = "created_at";
UPDATE "app"."tasks" AS task
SET
    "source_connection_id" = email."google_connection_id",
    "source_thread_id" = email."provider_thread_id",
    "source_revision" = email."source_revision"
FROM "app"."emails" AS email
WHERE task."user_id" = email."user_id"
    AND task."source_email_id" = email."id";

ALTER TABLE "app"."tasks"
    ADD CONSTRAINT "tasks_source_revision_positive_check" CHECK ("source_revision" > 0),
    ADD CONSTRAINT "tasks_source_email_thread_pair_check"
        CHECK (("source_email_id" IS NULL) = ("source_thread_id" IS NULL)
            AND ("source_email_id" IS NULL) = ("source_connection_id" IS NULL)),
    ADD CONSTRAINT "tasks_deduplication_key_format_check"
        CHECK ("deduplication_key" IS NULL OR btrim("deduplication_key"::text) ~ '^[a-f0-9]{64}$');

ALTER TABLE "app"."tasks"
    ADD CONSTRAINT "tasks_user_id_source_connection_id_fkey"
        FOREIGN KEY ("user_id", "source_connection_id")
        REFERENCES "app"."google_connections"("user_id", "id")
        ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "tasks_thread_deduplication_key"
    ON "app"."tasks"("user_id", "source_connection_id", "source_thread_id", "deduplication_key");
CREATE INDEX "tasks_user_thread_status_idx"
    ON "app"."tasks"("user_id", "source_connection_id", "source_thread_id", "status");

CREATE FUNCTION "app"."validate_task_source_thread"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    expected_thread_id VARCHAR(255);
    expected_connection_id UUID;
BEGIN
    IF NEW."source_email_id" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT email."provider_thread_id", email."google_connection_id"
        INTO expected_thread_id, expected_connection_id
    FROM "app"."emails" AS email
    WHERE email."user_id" = NEW."user_id" AND email."id" = NEW."source_email_id";

    IF expected_thread_id IS NOT NULL AND (
        NEW."source_thread_id" IS DISTINCT FROM expected_thread_id
        OR NEW."source_connection_id" IS DISTINCT FROM expected_connection_id
    ) THEN
        RAISE EXCEPTION 'task source thread does not match source email'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "tasks_validate_source_thread"
BEFORE INSERT OR UPDATE OF "user_id", "source_email_id", "source_connection_id", "source_thread_id"
ON "app"."tasks"
FOR EACH ROW EXECUTE FUNCTION "app"."validate_task_source_thread"();

CREATE TABLE "app"."commitments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source_email_id" UUID NOT NULL,
    "source_connection_id" UUID NOT NULL,
    "source_thread_id" VARCHAR(255) NOT NULL,
    "source_revision" INTEGER NOT NULL DEFAULT 1,
    "source_evidence" TEXT NOT NULL,
    "deduplication_key" CHAR(64) NOT NULL,
    "speaker" "app"."commitment_speaker" NOT NULL,
    "statement" VARCHAR(300) NOT NULL,
    "due_at" TIMESTAMPTZ(6),
    "due_timezone" VARCHAR(128),
    "confidence" DOUBLE PRECISION,
    "status" "app"."commitment_status" NOT NULL DEFAULT 'pending_review',
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMPTZ(6),
    "fulfilled_at" TIMESTAMPTZ(6),
    "withdrawn_at" TIMESTAMPTZ(6),
    "dismissed_at" TIMESTAMPTZ(6),
    "superseded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commitments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commitments_source_revision_positive_check" CHECK ("source_revision" > 0),
    CONSTRAINT "commitments_confidence_range_check"
        CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
    CONSTRAINT "commitments_deduplication_key_format_check"
        CHECK (btrim("deduplication_key"::text) ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "commitments_user_id_id_key"
    ON "app"."commitments"("user_id", "id");
CREATE UNIQUE INDEX "commitments_thread_deduplication_key"
    ON "app"."commitments"("user_id", "source_connection_id", "source_thread_id", "deduplication_key");
CREATE INDEX "commitments_user_status_due_at_idx"
    ON "app"."commitments"("user_id", "status", "due_at");
CREATE INDEX "commitments_user_thread_status_idx"
    ON "app"."commitments"("user_id", "source_connection_id", "source_thread_id", "status");

ALTER TABLE "app"."commitments"
    ADD CONSTRAINT "commitments_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "commitments_user_id_source_email_id_fkey"
        FOREIGN KEY ("user_id", "source_email_id") REFERENCES "app"."emails"("user_id", "id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "commitments_user_id_source_connection_id_fkey"
        FOREIGN KEY ("user_id", "source_connection_id") REFERENCES "app"."google_connections"("user_id", "id")
        ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION "app"."validate_commitment_source_thread"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    expected_thread_id VARCHAR(255);
    expected_connection_id UUID;
BEGIN
    SELECT email."provider_thread_id", email."google_connection_id"
        INTO expected_thread_id, expected_connection_id
    FROM "app"."emails" AS email
    WHERE email."user_id" = NEW."user_id" AND email."id" = NEW."source_email_id";

    IF expected_thread_id IS NOT NULL AND (
        NEW."source_thread_id" IS DISTINCT FROM expected_thread_id
        OR NEW."source_connection_id" IS DISTINCT FROM expected_connection_id
    ) THEN
        RAISE EXCEPTION 'commitment source thread does not match source email'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "commitments_validate_source_thread"
BEFORE INSERT OR UPDATE OF "user_id", "source_email_id", "source_connection_id", "source_thread_id"
ON "app"."commitments"
FOR EACH ROW EXECUTE FUNCTION "app"."validate_commitment_source_thread"();
