# MailPilot AI

MailPilot AI is a privacy-minded Gmail operations agent scaffold. It supports application sign-in through Google OpenID Connect with database-backed sessions, read-only Gmail synchronization, owner-scoped structured email analysis, evidence-linked reply suggestions, grounded historical email answers, and a connected-mailbox analysis panel. Reply suggestions are editable and stored without any send capability. The synthetic evaluation set and scorer are in place; the live-model baseline awaits provider configuration.

## Architecture

- `apps/web`: Next.js App Router, TypeScript, Tailwind CSS. Browser UI; no provider credentials.
- `apps/api`: Express and TypeScript. Public API boundary, Google OIDC application sign-in, Gmail OAuth with read-only access, bounded Gmail synchronization, owner-scoped email analysis and reply-suggestion persistence, and database readiness check.
- `apps/ai`: FastAPI and Python. AI service health, provider-neutral LLM and embedding contracts, structured email analysis, evidence-validated reply suggestions, and a persistent, read-only LangGraph RAG workflow with bounded intent planning and owner-scoped search/answer tools.
- `packages/shared`: TypeScript types and Zod runtime schemas shared by web and API.
- `prisma/`: stable Prisma ORM 7 schema and initial migration. PostgreSQL is local system-of-record infrastructure; `vector` extension is created in the initial migration.
- `docs/`: approved architecture, contracts, data model, security, evaluation, and roadmap.

Application and package versions are exact-pinned in `package.json` and `apps/ai/pyproject.toml`; `package-lock.json` and `apps/ai/uv.lock` pin transitive dependencies. Version selection and local requirements are documented in [docs/engineering-setup.md](docs/engineering-setup.md).

Python service development and dependency updates are documented in [apps/ai/README.md](apps/ai/README.md).
The initial embedding model and adapter limits are documented in [docs/embedding-provider.md](docs/embedding-provider.md).
The read-only RAG StateGraph and its Mermaid visualization are documented in [docs/rag-workflow.mmd](docs/rag-workflow.mmd).
Checkpoint identity, resume behavior, graph traces, and failure recovery are documented in [docs/agent-workflow-persistence.md](docs/agent-workflow-persistence.md).

## Manual prerequisites

1. Node.js **22.13 or later on the 22.x line** and npm **10.9 or later**. The current ESLint 10 and Prisma 7 toolchain needs a supported modern Node runtime.
2. Python **3.12.x** and `uv` **0.12.18** ([official installation instructions](https://docs.astral.sh/uv/getting-started/installation/)).
3. Docker Desktop with Docker Compose v2, started and available on PATH. Docker is not installed in every development environment; without it, PostgreSQL health readiness will stay unavailable unless a compatible local PostgreSQL server with pgvector is provided.
4. Network access to npm and Python package registries for a first install. Provider calls require `OPENAI_API_KEY`; mocked tests and health routes do not.
5. Host ports **3000**, **4000**, **8000**, and **55432** must be available. Compose publishes the database only on loopback; its port avoids the conventional local PostgreSQL port `5432`.
6. To test real sign-in and Gmail connection, configure the separate Google OAuth clients described in [docs/google-cloud-setup.md](docs/google-cloud-setup.md). Application sign-in requests only `openid email`; Gmail authorization separately requests the read-only Gmail scope. Server-to-server analysis and reply drafting require a shared local `AI_SERVICE_TOKEN` and an `OPENAI_API_KEY` for FastAPI.

## Setup

From the repository root in PowerShell:

```powershell
Copy-Item .env.example .env
npm ci
uv sync --project apps/ai --locked
npm run db:up
docker compose ps
npm run db:generate
npm run db:deploy
npm run db:ai:migrate
npm run db:seed
```

`db:up` starts only PostgreSQL; the three application services run as local development processes. Wait until `docker compose ps` reports the database as `healthy` before running migrations. Compose-managed named storage retains database files across container restarts and `npm run db:down`.

The example `.env` values are local-only placeholders. Do not use them outside a developer machine. The file is ignored by Git. `DATABASE_URL` must use the same database name, username, password, and host port as the Compose settings.

Application pages require an active session. Sign-in creates a new random session token, stores only its SHA-256 hash in PostgreSQL, and sets an HttpOnly cookie. The API checks expiry and revocation on each protected request; sign-out revokes the session. Production cookies use the `__Host-` prefix, `Secure`, `HttpOnly`, and `SameSite=Lax`. The CSRF cookie is `SameSite=Strict` and is checked with the request Origin on writes.

The seed command is explicit and local-development-only. It refuses any target other than the loopback `mailpilot` database on port `55432` and inserts one synthetic user with an `.invalid` address. It never clears existing data and does not create Gmail accounts, credentials, or messages. Prisma ORM 7 runs seed scripts only when `prisma db seed` is invoked explicitly.

## Database integration tests

The normal unit suite skips PostgreSQL integration tests unless `DATABASE_TEST_URL` is set. To run the real connectivity and migration checks against a dedicated local database:

```powershell
Copy-Item .env.test.example .env.test
docker compose exec -T db createdb -U mailpilot mailpilot_test
npm run test:db
```

The integration test accepts only a loopback PostgreSQL URL for database `mailpilot_test` on port `55432`. Each run resets that test database, applies the checked-in migrations, verifies a Prisma adapter query, and performs a synthetic user read/write round trip. Do not point `DATABASE_TEST_URL` at a development or production database.

## Run all applications

```powershell
npm run dev:all
```

Or run each in its own terminal:

```powershell
npm run dev:web
npm run dev:api
npm run dev:ai
```

The web, API, and AI service listen at `http://localhost:3000`, `http://localhost:4000`, and `http://localhost:8000`. Start PostgreSQL with `npm run db:up` before launching the services. `npm run dev:all` starts all three applications and stops the group when interrupted with Ctrl+C.

## Health checks

| Component | URL | Expected when dependencies are ready |
|---|---|---|
| Web liveness | `http://localhost:3000/api/health` | HTTP 200, JSON `{ "service": "web", "status": "ok", "requestId": "..." }` |
| Express liveness | `http://localhost:4000/health/live` | HTTP 200, JSON status `ok` |
| Express readiness + PostgreSQL | `http://localhost:4000/health/ready` | HTTP 200 only when `SELECT 1` succeeds; otherwise HTTP 503 with a safe error code |
| FastAPI liveness | `http://localhost:8000/internal/v1/health/live` (`/health/live` alias) | HTTP 200, JSON status `ok` |
| FastAPI readiness + PostgreSQL | `http://localhost:8000/internal/v1/health/ready` (`/health/ready` alias) | HTTP 200 only when `SELECT 1` succeeds; otherwise HTTP 503 with safe status |
| PostgreSQL/pgvector | `docker compose exec db pg_isready -U mailpilot -d mailpilot` | `accepting connections`; `SELECT extname FROM pg_extension WHERE extname = 'vector';` returns `vector` after migrations. Host port `55432` avoids a local PostgreSQL service on `5432`. |

Use `npm run db:up`, `npm run db:down`, and `npm run db:logs` to manage the local database.

## Troubleshooting

- **Docker command not found or daemon unavailable:** install/start Docker Desktop with Compose v2, then check `docker info` and `docker compose version`.
- **Database stays unhealthy:** inspect `docker compose ps` and `docker compose logs --tail=100 db`; confirm port `55432` is available and `.env` database settings match `.env.example`.
- **API or AI readiness returns 503:** confirm PostgreSQL is healthy, `DATABASE_URL` points to `localhost:55432`, and the database is accepting connections. Then run `npm run db:deploy` if this is a new database.
- **Database reports the wrong password after changing `.env`:** the named volume retains the original PostgreSQL initialization. Keep the original local credentials or deliberately recreate the local database volume; recreating it deletes its stored data.
- **A service port is occupied:** stop the process using port `3000`, `4000`, `8000`, or `55432`, then restart the affected service.
- **Python dependency sync says the lock is stale:** update the exact pin in `apps/ai/pyproject.toml`, run `uv lock --project apps/ai`, then retry `uv sync --project apps/ai --locked`.

## Quality checks

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run db:validate
```

Focused commands:

```powershell
npm run lint:ts
npm run lint:py
npm run typecheck:ts
npm run typecheck:py
npm run test:ts
npm run test:py
```

TypeScript unit tests use Vitest. Python tests use pytest with HTTPX's async ASGI transport; external providers and PostgreSQL checks are mocked in unit tests. Health readiness must be checked against the local Compose database for the full integration check.

## Repository guidance

Read [AGENTS.md](AGENTS.md) before making changes. See [docs/architecture.md](docs/architecture.md) for service ownership and [docs/roadmap.md](docs/roadmap.md) for the next implementation phases.
