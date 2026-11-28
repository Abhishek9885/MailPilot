ALTER TYPE "app"."pending_action_status" ADD VALUE IF NOT EXISTS 'executing';
ALTER TYPE "app"."pending_action_status" ADD VALUE IF NOT EXISTS 'succeeded';
ALTER TYPE "app"."pending_action_status" ADD VALUE IF NOT EXISTS 'failed';

-- Keep the proposal snapshot write-once and enforce the lifecycle in PostgreSQL
-- as well as in the owner-scoped Express service.
CREATE OR REPLACE FUNCTION "app"."guard_pending_action_snapshot"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    transition_allowed BOOLEAN;
BEGIN
    IF ROW(
        NEW."id",
        NEW."user_id",
        NEW."agent_run_id",
        NEW."idempotency_key",
        NEW."action_type",
        NEW."canonical_payload",
        NEW."payload_hash",
        NEW."payload_version",
        NEW."created_at",
        NEW."expires_at"
    ) IS DISTINCT FROM ROW(
        OLD."id",
        OLD."user_id",
        OLD."agent_run_id",
        OLD."idempotency_key",
        OLD."action_type",
        OLD."canonical_payload",
        OLD."payload_hash",
        OLD."payload_version",
        OLD."created_at",
        OLD."expires_at"
    ) THEN
        RAISE EXCEPTION 'pending action proposal snapshots are immutable'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."status"::text IS DISTINCT FROM OLD."status"::text THEN
        transition_allowed :=
            (OLD."status"::text = 'pending' AND NEW."status"::text IN ('approved', 'rejected', 'expired', 'cancelled'))
            OR (OLD."status"::text = 'approved' AND NEW."status"::text IN ('executing', 'expired'))
            OR (OLD."status"::text = 'executing' AND NEW."status"::text IN ('succeeded', 'failed'));

        IF NOT transition_allowed THEN
            RAISE EXCEPTION 'invalid pending action state transition'
                USING ERRCODE = '23514';
        END IF;

        IF OLD."status"::text = 'pending' AND NEW."decided_at" IS NULL THEN
            RAISE EXCEPTION 'pending action decision time is required'
                USING ERRCODE = '23514';
        END IF;

        IF OLD."status"::text <> 'pending' AND NEW."decided_at" IS DISTINCT FROM OLD."decided_at" THEN
            RAISE EXCEPTION 'pending action decision time is immutable after decision'
                USING ERRCODE = '23514';
        END IF;
    ELSIF NEW."decided_at" IS DISTINCT FROM OLD."decided_at" THEN
        RAISE EXCEPTION 'pending action decision time requires a state transition'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;
