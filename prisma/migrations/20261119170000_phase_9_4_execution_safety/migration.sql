ALTER TYPE "app"."pending_action_status" ADD VALUE IF NOT EXISTS 'reconciliation_required';

ALTER TABLE "app"."pending_actions"
    ADD COLUMN "execution_key" CHAR(64),
    ADD COLUMN "execution_started_at" TIMESTAMPTZ(6),
    ADD COLUMN "execution_lease_expires_at" TIMESTAMPTZ(6),
    ADD COLUMN "execution_attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "execution_result_code" VARCHAR(128),
    ADD COLUMN "reconciliation_claim_id" UUID,
    ADD COLUMN "reconciliation_lease_expires_at" TIMESTAMPTZ(6),
    ADD COLUMN "reconciliation_attempts" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "pending_actions_execution_key_key"
    ON "app"."pending_actions"("execution_key");

CREATE INDEX "pending_actions_execution_lease_idx"
    ON "app"."pending_actions"("status", "execution_lease_expires_at");

CREATE INDEX "pending_actions_reconciliation_lease_idx"
    ON "app"."pending_actions"("status", "reconciliation_lease_expires_at");

ALTER TABLE "app"."pending_actions"
    ADD CONSTRAINT "pending_actions_execution_attempts_nonnegative"
        CHECK ("execution_attempts" >= 0),
    ADD CONSTRAINT "pending_actions_reconciliation_attempts_nonnegative"
        CHECK ("reconciliation_attempts" >= 0),
    ADD CONSTRAINT "pending_actions_execution_key_format"
        CHECK ("execution_key" IS NULL OR btrim("execution_key"::text) ~ '^[a-f0-9]{64}$'),
    ADD CONSTRAINT "pending_actions_reconciliation_claim_pair"
        CHECK (("reconciliation_claim_id" IS NULL) = ("reconciliation_lease_expires_at" IS NULL));

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

    IF OLD."execution_key" IS NOT NULL AND NEW."execution_key" IS DISTINCT FROM OLD."execution_key" THEN
        RAISE EXCEPTION 'pending action execution key is immutable once claimed'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."status"::text IS DISTINCT FROM OLD."status"::text THEN
        transition_allowed :=
            (OLD."status"::text = 'pending' AND NEW."status"::text IN ('approved', 'rejected', 'expired', 'cancelled'))
            OR (OLD."status"::text = 'approved' AND NEW."status"::text IN ('executing', 'expired'))
            OR (OLD."status"::text = 'executing' AND NEW."status"::text IN ('succeeded', 'failed', 'reconciliation_required'))
            OR (OLD."status"::text = 'reconciliation_required' AND NEW."status"::text IN ('succeeded', 'failed', 'approved', 'expired'));

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

        IF OLD."status"::text = 'reconciliation_required'
            AND NEW."reconciliation_attempts" <> OLD."reconciliation_attempts" THEN
            RAISE EXCEPTION 'reconciliation attempt count may only change when claiming a check'
                USING ERRCODE = '23514';
        END IF;

        IF OLD."status"::text <> 'reconciliation_required'
            AND ROW(
                NEW."reconciliation_claim_id",
                NEW."reconciliation_lease_expires_at",
                NEW."reconciliation_attempts"
            ) IS DISTINCT FROM ROW(
                OLD."reconciliation_claim_id",
                OLD."reconciliation_lease_expires_at",
                OLD."reconciliation_attempts"
            ) THEN
            RAISE EXCEPTION 'reconciliation metadata may only change during reconciliation'
                USING ERRCODE = '23514';
        END IF;

        IF OLD."status"::text = 'reconciliation_required'
            AND (
                OLD."reconciliation_claim_id" IS NULL
                OR OLD."reconciliation_lease_expires_at" IS NULL
                OR OLD."reconciliation_lease_expires_at" <= CURRENT_TIMESTAMP
                OR NEW."reconciliation_claim_id" IS NOT NULL
                OR NEW."reconciliation_lease_expires_at" IS NOT NULL
            ) THEN
            RAISE EXCEPTION 'a live reconciliation claim is required to complete reconciliation'
                USING ERRCODE = '23514';
        END IF;

        IF NEW."status"::text = 'executing' THEN
            IF NEW."execution_key" IS NULL
                OR btrim(NEW."execution_key"::text) !~ '^[a-f0-9]{64}$'
                OR NEW."execution_started_at" IS NULL
                OR NEW."execution_lease_expires_at" IS NULL
                OR NEW."execution_lease_expires_at" <= CURRENT_TIMESTAMP
                OR NEW."execution_attempts" <> OLD."execution_attempts" + 1
                OR NEW."execution_result_code" IS NOT NULL THEN
                RAISE EXCEPTION 'execution claim metadata is invalid'
                    USING ERRCODE = '23514';
            END IF;
        ELSE
            IF NEW."execution_started_at" IS DISTINCT FROM OLD."execution_started_at" THEN
                RAISE EXCEPTION 'execution start time may only change on a claim'
                    USING ERRCODE = '23514';
            END IF;
            IF NEW."execution_lease_expires_at" IS NOT NULL THEN
                RAISE EXCEPTION 'execution lease must be cleared when leaving execution'
                    USING ERRCODE = '23514';
            END IF;
            IF NEW."execution_attempts" <> OLD."execution_attempts" THEN
                RAISE EXCEPTION 'execution attempt count may only change on a claim'
                    USING ERRCODE = '23514';
            END IF;
        END IF;

        IF NEW."status"::text IN ('succeeded', 'failed', 'reconciliation_required')
            AND NEW."execution_result_code" IS NULL THEN
            RAISE EXCEPTION 'completed or uncertain executions require a safe result code'
                USING ERRCODE = '23514';
        END IF;

        IF OLD."status"::text = 'reconciliation_required'
            AND NEW."status"::text = 'approved'
            AND (NEW."execution_result_code" IS DISTINCT FROM 'EXECUTION_NOT_PERFORMED_CONFIRMED'
                OR NEW."expires_at" <= CURRENT_TIMESTAMP) THEN
            RAISE EXCEPTION 'execution retry requires confirmed no-effect reconciliation and an unexpired approval'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        IF NEW."decided_at" IS DISTINCT FROM OLD."decided_at" THEN
            RAISE EXCEPTION 'pending action decision time requires a state transition'
                USING ERRCODE = '23514';
        END IF;
        IF ROW(
            NEW."execution_key",
            NEW."execution_started_at",
            NEW."execution_lease_expires_at",
            NEW."execution_attempts",
            NEW."execution_result_code"
        ) IS DISTINCT FROM ROW(
            OLD."execution_key",
            OLD."execution_started_at",
            OLD."execution_lease_expires_at",
            OLD."execution_attempts",
            OLD."execution_result_code"
        ) THEN
            RAISE EXCEPTION 'execution metadata requires a lifecycle transition'
                USING ERRCODE = '23514';
        END IF;

        IF NEW."status"::text = 'reconciliation_required'
            AND ROW(
                NEW."reconciliation_claim_id",
                NEW."reconciliation_lease_expires_at",
                NEW."reconciliation_attempts"
            ) IS DISTINCT FROM ROW(
                OLD."reconciliation_claim_id",
                OLD."reconciliation_lease_expires_at",
                OLD."reconciliation_attempts"
            ) THEN
            IF NEW."reconciliation_claim_id" IS NOT NULL
                AND NEW."reconciliation_claim_id" IS DISTINCT FROM OLD."reconciliation_claim_id"
                AND NEW."reconciliation_lease_expires_at" > CURRENT_TIMESTAMP
                AND NEW."reconciliation_attempts" = OLD."reconciliation_attempts" + 1
                AND (OLD."reconciliation_lease_expires_at" IS NULL
                    OR OLD."reconciliation_lease_expires_at" <= CURRENT_TIMESTAMP) THEN
                NULL;
            ELSIF NEW."reconciliation_claim_id" IS NULL
                AND NEW."reconciliation_lease_expires_at" IS NULL
                AND OLD."reconciliation_claim_id" IS NOT NULL
                AND NEW."reconciliation_attempts" = OLD."reconciliation_attempts" THEN
                NULL;
            ELSE
                RAISE EXCEPTION 'reconciliation lease metadata is invalid'
                    USING ERRCODE = '23514';
            END IF;
        ELSIF ROW(
            NEW."reconciliation_claim_id",
            NEW."reconciliation_lease_expires_at",
            NEW."reconciliation_attempts"
        ) IS DISTINCT FROM ROW(
            OLD."reconciliation_claim_id",
            OLD."reconciliation_lease_expires_at",
            OLD."reconciliation_attempts"
        ) THEN
            RAISE EXCEPTION 'reconciliation lease metadata requires an active check'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;
