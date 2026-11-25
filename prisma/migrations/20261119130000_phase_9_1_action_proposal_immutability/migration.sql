-- Pending action rows may change decision status later, but their proposal
-- snapshot and ownership metadata must remain exactly as first persisted.
CREATE FUNCTION "app"."guard_pending_action_snapshot"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
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

    RETURN NEW;
END;
$$;

CREATE TRIGGER "pending_actions_snapshot_immutable"
BEFORE UPDATE ON "app"."pending_actions"
FOR EACH ROW
EXECUTE FUNCTION "app"."guard_pending_action_snapshot"();
