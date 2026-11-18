CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

DO $$
DECLARE
    extension_version TEXT;
BEGIN
    SELECT extversion INTO extension_version
    FROM pg_extension
    WHERE extname = 'vector';

    IF extension_version IS NULL
       OR split_part(extension_version, '.', 1)::INTEGER < 0
       OR (
           split_part(extension_version, '.', 1)::INTEGER = 0
           AND split_part(extension_version, '.', 2)::INTEGER < 8
       ) THEN
        RAISE EXCEPTION 'pgvector 0.8.0 or newer is required';
    END IF;
END
$$;

CREATE TABLE ai.chunk_embeddings_1536 (
    user_id UUID NOT NULL,
    chunk_id UUID NOT NULL,
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    chunker_version VARCHAR(64) NOT NULL,
    content_hash CHAR(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    provider VARCHAR(64) NOT NULL,
    model VARCHAR(128) NOT NULL,
    model_version VARCHAR(128) NOT NULL,
    embedding_version CHAR(64) NOT NULL CHECK (embedding_version ~ '^[0-9a-f]{64}$'),
    dimensions SMALLINT NOT NULL DEFAULT 1536 CHECK (dimensions = 1536),
    embedding public.vector(1536) NOT NULL,
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chunk_embeddings_1536_pkey PRIMARY KEY (user_id, chunk_id, embedding_version),
    CONSTRAINT chunk_embeddings_1536_owner_chunk_fkey
        FOREIGN KEY (user_id, chunk_id)
        REFERENCES app.email_chunks (user_id, id)
        ON DELETE CASCADE
);

CREATE INDEX chunk_embeddings_1536_user_version_idx
    ON ai.chunk_embeddings_1536 (user_id, embedding_version, chunk_id);

CREATE INDEX chunk_embeddings_1536_hnsw_cosine_idx
    ON ai.chunk_embeddings_1536 USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

ALTER TABLE ai.chunk_embeddings_1536 ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.chunk_embeddings_1536 FORCE ROW LEVEL SECURITY;

CREATE POLICY chunk_embeddings_1536_owner_policy
    ON ai.chunk_embeddings_1536
    USING (user_id = NULLIF(current_setting('mailpilot.user_id', true), '')::UUID)
    WITH CHECK (user_id = NULLIF(current_setting('mailpilot.user_id', true), '')::UUID);
