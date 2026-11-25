-- The Prisma foundation migration installs pgvector in the first schema on
-- its search_path (app). AI storage uses public.vector explicitly, so move the
-- relocatable extension to public before creating any AI tables or indexes.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

DO $$
DECLARE
    extension_schema TEXT;
BEGIN
    SELECT ns.nspname
    INTO extension_schema
    FROM pg_extension AS ext
    JOIN pg_namespace AS ns ON ns.oid = ext.extnamespace
    WHERE ext.extname = 'vector';

    IF extension_schema IS NULL THEN
        RAISE EXCEPTION 'pgvector extension is not installed';
    END IF;

    IF extension_schema <> 'public' THEN
        EXECUTE 'ALTER EXTENSION vector SET SCHEMA public';
    END IF;
END
$$;
