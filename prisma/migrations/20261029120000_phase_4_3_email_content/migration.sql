ALTER TABLE "app"."emails"
    ALTER COLUMN "sender_email_normalized" DROP NOT NULL,
    ADD COLUMN "sender_name" TEXT,
    ADD COLUMN "body_html" TEXT,
    ADD COLUMN "attachment_metadata" JSONB NOT NULL DEFAULT '[]'::jsonb;
