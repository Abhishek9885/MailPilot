CREATE TYPE "app"."reply_draft_status" AS ENUM ('suggestion', 'dismissed');

CREATE TABLE "app"."reply_drafts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email_id" UUID NOT NULL,
    "source_revision" INTEGER NOT NULL,
    "schema_version" VARCHAR(64) NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "model_version" VARCHAR(128) NOT NULL,
    "subject" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "claims" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "uncertainties" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "source_messages" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "status" "app"."reply_draft_status" NOT NULL DEFAULT 'suggestion',
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reply_drafts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reply_drafts_user_email_created_idx"
    ON "app"."reply_drafts"("user_id", "email_id", "created_at" DESC);
CREATE INDEX "reply_drafts_user_status_created_idx"
    ON "app"."reply_drafts"("user_id", "status", "created_at" DESC);

ALTER TABLE "app"."reply_drafts"
    ADD CONSTRAINT "reply_drafts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app"."reply_drafts"
    ADD CONSTRAINT "reply_drafts_user_id_email_id_fkey"
    FOREIGN KEY ("user_id", "email_id") REFERENCES "app"."emails"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "app"."reply_drafts"
    ADD CONSTRAINT "reply_drafts_source_revision_positive_check"
    CHECK ("source_revision" > 0);
ALTER TABLE "app"."reply_drafts"
    ADD CONSTRAINT "reply_drafts_content_is_json_array_check"
    CHECK (jsonb_typeof("claims") = 'array' AND jsonb_typeof("uncertainties") = 'array'
        AND jsonb_typeof("source_messages") = 'array');
