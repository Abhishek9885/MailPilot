# CI, production configuration, and release runbook

Status: repository configuration is implemented for GitHub Actions and the Render baseline in [render.yaml](../render.yaml). This does not deploy anything by itself; production deploys require a protected GitHub environment, Render secrets, database roles, and a completed staging rehearsal.

The attempted Phase 14.3 preflight did not provision or deploy production resources. See the [deployment record](production-deployment-record.md) for test results and current blockers.

## CI checks

`.github/workflows/ci.yml` runs for pull requests and pushes to `main`. It installs the exact Node and uv versions from the repository, starts an isolated `pgvector/pgvector:0.8.7-pg17` service, and runs:

1. `npm ci` and `uv sync --project apps/ai --locked`.
2. `npm audit --audit-level=high`, `npm run lint`, and `npm run typecheck`.
3. `npm test`, including API database integration and AI vector/checkpointer tests against the temporary `_test` database.
4. `npm run db:validate`, `npm run build` for shared/API/web, and `uv build` for the FastAPI distribution.

The integration database has a conspicuous CI-only password and is discarded with the runner. Provider keys, OAuth secrets, mailbox data, and production URLs are not supplied to CI. No database seed command runs in CI or in the Render build. The evaluation fixtures checked into `eval/` are synthetic; never put a real mailbox export in CI artifacts or test fixtures.

The production job only runs for a successful push to `main`. It targets the exact commit SHA and deploys in this order: Express API, FastAPI, Node worker, then Next.js. `scripts/deploy-render.mjs` polls each Render deployment to a terminal status and then requires the web, API, and AI readiness endpoints to return healthy JSON. A failed deploy or probe fails the job and stops later services.

In GitHub repository settings, protect `main`: require pull requests, at least one review, the **Lint, typecheck, integration tests, and build** status check, and prohibit force pushes and routine direct pushes. Create a `production` Environment, require an independent reviewer, and prevent self-approval. Store these as **environment secrets** (not repository variables):

- `RENDER_API_TOKEN` with permission only to deploy these four services where Render supports service-scoped permissions.
- `RENDER_API_SERVICE_ID`
- `RENDER_AI_SERVICE_ID`
- `RENDER_WORKER_SERVICE_ID`
- `RENDER_WEB_SERVICE_ID`

Configure the Render services with automatic deployment turned off. The GitHub production job is the deployment gate. Do not approve that environment until the database steps in this runbook and the release checklist have passed.

## Render service configuration

Before creating or syncing the Render Blueprint, validate it with Render CLI v2.7.1 or later:

```powershell
render blueprints validate render.yaml
```

This validates YAML syntax, Blueprint fields, plans, regions, and conflicts with resources in the selected workspace. Review the proposed paid resources before confirming a Blueprint sync.

The Blueprint provisions the following in Singapore: public Next.js, private Express, public HTTPS FastAPI, a private Node worker, paid PostgreSQL 17, and persistent Key Value with `noeviction`. The web service rewrites `/v1/*` and `/health/*` to the API's private host and port. The browser and Google OAuth callbacks therefore use the same web origin. Express calls the HTTPS AI service with the shared HMAC token. FastAPI does not receive Gmail client credentials, session keys, or Gmail OAuth tokens.

When creating the Blueprint:

1. Confirm the Render workspace and billing plan before applying the paid service and database plans. Keep all resources in the same region and environment.
2. Create staging from a separate copy of this Blueprint with distinct resource names, database, Key Value, OAuth clients, and credentials. Do not attach production mailboxes or credentials to staging or pull-request previews.
3. Supply the OAuth client values requested by the Blueprint from the production secret manager. Use dedicated production OAuth clients and register the exact callback URLs in the Google clients:
   - `https://mailpilot-web.onrender.com/v1/auth/google/callback`
   - `https://mailpilot-web.onrender.com/v1/oauth/google/callback`
   - `https://mailpilot-web.onrender.com/v1/oauth/google-calendar/callback`
4. Set API `DATABASE_URL` to the internal Postgres URL for the restricted API runtime role with `?schema=app&sslmode=require`. Set FastAPI `AI_DATABASE_URL` to a distinct internal URL for its restricted AI runtime role, also requiring TLS. Do not copy the Postgres owner URL into either service.
5. Create the Key Value instance with external access blocked. Obtain the current Singapore Render service egress CIDR ranges, replace `ipAllowList: []` in `render.yaml` with those exact ranges, and sync the Blueprint. Enable the external endpoint and set API `REDIS_URL` to that authenticated `rediss://` URL. The API and worker must use TLS and provider authentication; never allow `0.0.0.0/0`. Render's shared regional egress ranges can change, so review the allowlist when Render updates them.
6. Keep `GOOGLE_CALENDAR_EVENTS_ENABLED=false`. FastAPI receives `AI_DATABASE_URL`, `AI_SERVICE_TOKEN`, and `OPENAI_API_KEY`; the Node worker receives only the Express-side credentials it needs. The Next.js service receives no server secrets.
7. If a custom domain replaces the Render web hostname, update the public web build value, `WEB_ORIGIN`, `API_PUBLIC_ORIGIN`, the `environment.url` in the workflow, the health URLs in `scripts/deploy-render.mjs`, and all Google callback URIs together, then rebuild and deploy. The public API origin must have the same host as the browser origin.

The Blueprint's `sync: false` values are prompts for the first Blueprint creation only; subsequent new secrets must be added in the Render Dashboard. Rotate secrets through the secret manager and dependent service redeploys. Never commit `.env`, copy it into an image, upload it as an artifact, or put any secret in a `NEXT_PUBLIC_*` variable. Local `.env` files are gitignored. Node build commands unset runtime secrets before invoking npm, use a dummy database URL only for Prisma client generation, prune development dependencies, and remove tests, synthetic evaluation fixtures, documentation, and the Python service tree before deployment. FastAPI's build runs from `apps/ai` and removes its tests, training/evaluation scripts, and local evaluation fixtures after syncing locked production dependencies. The classifier artifact required for inference remains. No test dataset or mailbox seed runs in production.

### Database roles and migration separation

Keep the Render database owner for schema management and recovery. Create separate runtime logins:

- **API runtime:** DML permissions on the application tables and required sequences; no schema ownership or DDL.
- **AI runtime:** `SELECT` on `app.emails`, `SELECT`/`INSERT`/`UPDATE` on `app.email_chunks`, and DDL permissions within its own `ai` schema required by LangGraph checkpoint initialization. It must not be able to read `app.google_connections`, sessions, or OAuth token columns. Grant `REFERENCES` to the AI migration identity only for the source tables referenced by AI-owned foreign keys.
- **Migration identities:** separate, short-lived operator credentials for Prisma's `app` migrations and the Python-owned `ai` migrations. Never place them in Render service variables or GitHub secrets.

Review these grants against the SQL in `apps/ai/src/mailpilot_ai/email_indexing` and the two migration directories. Keep default privileges narrow when future tables are added. Recheck with real role-based tests in staging before storing real mailbox data. PostgreSQL role grants restrict the AI service's reach; request-level user scoping and RLS remain required as well.

### Apply migrations before deployment

The two migration systems own separate schemas, and AI migrations reference Prisma-owned `app` tables. Apply them in order from a trusted operator workstation checked out at the exact green CI commit:

1. Take or confirm a current recoverable PostgreSQL point. Use a temporary external database allowlist entry for the operator's fixed IP and TLS (`sslmode=require`). Do not use a broad public allowlist.
2. Load the migration-only URL for `app` into `DATABASE_URL` from an approved secret manager. It must not be the API runtime URL. Then run:

   ```powershell
   npm ci
   npm run db:deploy
   ```

3. Remove that environment value. Load the AI migration URL into `AI_DATABASE_URL` from the approved secret manager, then run:

   ```powershell
   uv sync --project apps/ai --locked
   uv run --directory apps/ai --project . python -m mailpilot_ai.vector_store.migrations
   ```

4. Remove the temporary environment values and the operator IP from the Postgres allowlist. Record the commit SHA, migration results, operator, and recovery point in the release record.
5. Approve the GitHub `production` environment only after these steps and staging smoke checks have passed. The deploy job then updates API, AI, worker, and web at the same commit.

Do not run migrations concurrently or from service startup. Do not run `npm run db:ai:migrate` in production because that local helper loads the repository `.env`. Additive expand/contract changes are required while old and new services may overlap.

## Health checks and release verification

Render probes `/api/health` on Next.js and `/health/live` on FastAPI. The API private service uses the platform's TCP check; the deployment workflow also checks `/health/ready` through the web proxy after the worker is deployed. AI readiness checks PostgreSQL. These endpoints expose only service status and a request ID; they do not include email, database details, or secrets.

After deployment, verify:

- `https://mailpilot-web.onrender.com/api/health`, `/health/live`, and `/health/ready` return healthy status.
- Sign-in, Gmail consent/read-only sync, and analysis with a dedicated staging/test account; confirm message ownership in the UI.
- Worker heartbeat and queue processing are healthy; logs have request/run IDs and no mailbox content, tokens, or provider response bodies.
- Calendar remains connected only if configured, and event creation remains disabled until its approval/security release gate passes.
- Backup freshness, database storage/connections, queue depth, 5xx rate, latency, and provider limits are monitored.

The existing [release checklist](release-gates.md) remains the final quality/security gate. The Next.js security update is applied and audited. The unrun live PostgreSQL migration, role-scoping, restore/recovery checks, and provider smoke tests must pass before onboarding real users.

## Rollback and recovery

1. If the deploy job or readiness probe fails, stop further releases. Render keeps the last healthy service deploy when a new deploy fails; inspect the failed service logs by safe request ID and leave the database migration in place.
2. For an application-only regression, roll back compatible services to their previous successful deploy in reverse dependency order: web, worker, AI, then API. Re-run the public readiness probes and check worker heartbeat. Do not roll back an applied SQL migration automatically.
3. If the schema or data migration is unsafe, pause sync/worker traffic. Restore PostgreSQL point-in-time recovery to a **new** database, validate both `app` and `ai` schemas, `vector`, role grants, and owner-scoped reads there, then update runtime URLs only after review. Retain the original database until cutover is verified.
4. If queue state is lost, use the database outbox/sync records to reconcile work and requeue idempotently. Do not clear durable outbox records as a recovery shortcut.
5. If credentials may be exposed, disable/rotate the affected OAuth client or provider key, rotate session and service-signing secrets, redeploy the dependent services, and review audit logs. Revoke tokens rather than copying them into logs or support tickets.

For backup schedules, PITR limits, and a restore drill, use [the deployment architecture runbook](deployment-architecture.md#backups-and-recovery).
