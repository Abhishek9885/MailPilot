CREATE TABLE ai.email_index_jobs (
    user_id UUID NOT NULL,
    email_id UUID NOT NULL,
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    chunker_version VARCHAR(64) NOT NULL,
    configured_model VARCHAR(128) NOT NULL,
    model_version VARCHAR(128),
    status VARCHAR(16) NOT NULL CHECK (status IN ('processing', 'completed', 'failed', 'deleted')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
    embedded_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (embedded_chunk_count >= 0),
    safe_error_code VARCHAR(128),
    started_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ(6),
    lease_expires_at TIMESTAMPTZ(6),
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT email_index_jobs_pkey
        PRIMARY KEY (user_id, email_id, source_revision, chunker_version, configured_model),
    CONSTRAINT email_index_jobs_owner_email_fkey
        FOREIGN KEY (user_id, email_id)
        REFERENCES app.emails (user_id, id)
        ON DELETE CASCADE,
    CONSTRAINT email_index_jobs_counts_check
        CHECK (embedded_chunk_count <= chunk_count)
);

CREATE INDEX email_index_jobs_user_status_idx
    ON ai.email_index_jobs (user_id, status, updated_at DESC);

ALTER TABLE ai.email_index_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.email_index_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY email_index_jobs_owner_policy
    ON ai.email_index_jobs
    USING (user_id = NULLIF(current_setting('mailpilot.user_id', true), '')::UUID)
    WITH CHECK (user_id = NULLIF(current_setting('mailpilot.user_id', true), '')::UUID);
