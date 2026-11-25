ALTER TABLE "app"."pending_actions"
    ALTER COLUMN "agent_run_id" DROP NOT NULL;

CREATE TABLE "app"."google_calendar_connections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider_subject" VARCHAR(255) NOT NULL,
    "provider_email_normalized" VARCHAR(320) NOT NULL,
    "refresh_token_ciphertext" TEXT,
    "refresh_token_nonce" VARCHAR(16),
    "refresh_token_auth_tag" VARCHAR(22),
    "token_encryption_key_version" VARCHAR(64),
    "status" "app"."google_connection_status" NOT NULL DEFAULT 'active',
    "granted_scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "connected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnected_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "google_calendar_connections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "google_calendar_connections_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "google_calendar_connections_token_parts_check" CHECK (
        ("refresh_token_ciphertext" IS NULL AND "refresh_token_nonce" IS NULL AND "refresh_token_auth_tag" IS NULL AND "token_encryption_key_version" IS NULL)
        OR
        ("refresh_token_ciphertext" IS NOT NULL AND "refresh_token_nonce" IS NOT NULL AND "refresh_token_auth_tag" IS NOT NULL AND "token_encryption_key_version" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "google_calendar_connections_user_id_key"
    ON "app"."google_calendar_connections"("user_id");
CREATE UNIQUE INDEX "google_calendar_connections_provider_subject_key"
    ON "app"."google_calendar_connections"("provider_subject");
