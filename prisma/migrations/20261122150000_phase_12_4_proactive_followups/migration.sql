ALTER TYPE "app"."follow_up_status" ADD VALUE 'dismissed';

CREATE TABLE "app"."follow_up_settings" (
    "user_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "commitment_reminders_enabled" BOOLEAN NOT NULL DEFAULT true,
    "stale_thread_suggestions_enabled" BOOLEAN NOT NULL DEFAULT true,
    "commitment_lead_hours" INTEGER NOT NULL DEFAULT 24,
    "stale_thread_after_days" INTEGER NOT NULL DEFAULT 5,
    "time_zone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "quiet_hours_start" INTEGER,
    "quiet_hours_end" INTEGER,
    "daily_suggestion_limit" INTEGER NOT NULL DEFAULT 5,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "follow_up_settings_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "follow_up_settings_commitment_lead_check" CHECK ("commitment_lead_hours" BETWEEN 0 AND 168),
    CONSTRAINT "follow_up_settings_stale_days_check" CHECK ("stale_thread_after_days" BETWEEN 1 AND 90),
    CONSTRAINT "follow_up_settings_daily_limit_check" CHECK ("daily_suggestion_limit" BETWEEN 1 AND 20),
    CONSTRAINT "follow_up_settings_quiet_hours_check" CHECK (
      (("quiet_hours_start" IS NULL AND "quiet_hours_end" IS NULL) OR
       ("quiet_hours_start" BETWEEN 0 AND 23 AND "quiet_hours_end" BETWEEN 0 AND 23 AND "quiet_hours_start" <> "quiet_hours_end"))
    )
);
ALTER TABLE "app"."follow_up_settings"
    ADD CONSTRAINT "follow_up_settings_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "app"."follow_ups"
    DROP CONSTRAINT IF EXISTS "follow_ups_email_schedule_key";
DROP INDEX IF EXISTS "app"."follow_ups_email_schedule_key";

ALTER TABLE "app"."follow_ups"
    ADD COLUMN "commitment_id" UUID,
    ADD COLUMN "source_thread_id" VARCHAR(255),
    ADD COLUMN "kind" VARCHAR(32) NOT NULL DEFAULT 'stale_thread',
    ADD COLUMN "deduplication_key" VARCHAR(255),
    ADD COLUMN "title" VARCHAR(300) NOT NULL DEFAULT 'Follow up on this conversation',
    ADD COLUMN "reason" VARCHAR(500) NOT NULL DEFAULT 'This conversation may need your attention.',
    ADD COLUMN "last_activated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "app"."follow_ups" AS f
SET "source_thread_id" = e."provider_thread_id",
    "deduplication_key" = 'legacy:' || f."id"::text
FROM "app"."emails" AS e
WHERE e."user_id" = f."user_id" AND e."id" = f."email_id";

ALTER TABLE "app"."follow_ups"
    ALTER COLUMN "kind" DROP DEFAULT,
    ALTER COLUMN "title" DROP DEFAULT,
    ALTER COLUMN "reason" DROP DEFAULT;

ALTER TABLE "app"."follow_ups"
    ALTER COLUMN "source_thread_id" SET NOT NULL,
    ALTER COLUMN "deduplication_key" SET NOT NULL;
CREATE UNIQUE INDEX "follow_ups_user_dedupe_key"
    ON "app"."follow_ups"("user_id", "deduplication_key");
CREATE INDEX "follow_ups_user_activated_idx"
    ON "app"."follow_ups"("user_id", "last_activated_at");
ALTER TABLE "app"."follow_ups"
    ADD CONSTRAINT "follow_ups_commitment_owner_fkey"
    FOREIGN KEY ("user_id", "commitment_id") REFERENCES "app"."commitments"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app"."follow_ups" ADD CONSTRAINT "follow_ups_kind_check" CHECK ("kind" IN ('commitment_reminder', 'stale_thread'));
