DO $$
BEGIN
    IF to_regtype('app.task_due_date_source') IS NULL THEN
        CREATE TYPE "app"."task_due_date_source" AS ENUM (
            'explicit',
            'inferred',
            'user',
            'none',
            'unknown'
        );
    END IF;
END
$$;

ALTER TABLE "app"."tasks"
    ADD COLUMN IF NOT EXISTS "due_date_source" "app"."task_due_date_source" NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS "title_edited_at" TIMESTAMPTZ(6);

UPDATE "app"."tasks"
SET "due_date_source" = CASE
    WHEN "due_at" IS NULL THEN 'none'::"app"."task_due_date_source"
    ELSE 'unknown'::"app"."task_due_date_source"
END;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'app.tasks'::regclass
          AND conname = 'tasks_due_date_source_consistency_check'
    ) THEN
        ALTER TABLE "app"."tasks"
            ADD CONSTRAINT "tasks_due_date_source_consistency_check" CHECK (
                ("due_date_source" = 'none'::"app"."task_due_date_source" AND "due_at" IS NULL)
                OR ("due_date_source" IN (
                    'explicit'::"app"."task_due_date_source",
                    'inferred'::"app"."task_due_date_source"
                ) AND "due_at" IS NOT NULL)
                OR "due_date_source" IN (
                    'user'::"app"."task_due_date_source",
                    'unknown'::"app"."task_due_date_source"
                )
            );
    END IF;
END
$$;
