ALTER TABLE "app"."google_connections"
    ADD COLUMN "refresh_token_ciphertext" TEXT,
    ADD COLUMN "refresh_token_nonce" VARCHAR(16),
    ADD COLUMN "refresh_token_auth_tag" VARCHAR(22),
    ADD COLUMN "token_encryption_key_version" VARCHAR(64);

ALTER TABLE "app"."google_connections"
    ADD CONSTRAINT "google_connections_refresh_token_encryption_check"
    CHECK (
        ("refresh_token_ciphertext" IS NULL AND "refresh_token_nonce" IS NULL AND "refresh_token_auth_tag" IS NULL AND "token_encryption_key_version" IS NULL)
        OR
        ("refresh_token_ciphertext" IS NOT NULL AND "refresh_token_nonce" IS NOT NULL AND "refresh_token_auth_tag" IS NOT NULL AND "token_encryption_key_version" IS NOT NULL)
    );

DROP INDEX "app"."google_connections_user_status_idx";
CREATE UNIQUE INDEX "google_connections_user_id_key" ON "app"."google_connections"("user_id");
