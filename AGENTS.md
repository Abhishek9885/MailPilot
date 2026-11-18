# MailPilot AI contributor instructions

## Architecture

- Preserve the three application boundaries: Next.js (`apps/web`), Express (`apps/api`), and FastAPI (`apps/ai`). `packages/shared` contains TypeScript contracts only; it must not contain service logic or secrets.
- The browser talks to Express. Express owns future user identity, OAuth credentials, Gmail synchronization, and all Gmail side effects. FastAPI owns future model orchestration and retrieval, but must never receive Gmail OAuth tokens.
- PostgreSQL is the system of record. Prisma owns the application schema; the Python service will own AI/index tables in a separately managed schema. Do not let two migration tools manage the same tables. pgvector stays in this PostgreSQL instance.
- Redis/BullMQ, OAuth, Gmail API access, AI provider calls, embeddings, LangGraph workflows, and background jobs are not implemented in this phase. Do not add them without a scoped request and corresponding architecture update.

## Commands

Run from the repository root:

```powershell
npm ci
uv sync --project apps/ai --locked
docker compose up -d db
npm run dev:all
npm run lint
npm run typecheck
npm test
npm run build
npm run db:validate
npm run db:generate
npm run db:deploy
```

Individual service commands are documented in `README.md`. TypeScript workspaces use npm; Python is pinned by `pyproject.toml` and `uv.lock`. Do not introduce pnpm or a second JavaScript lockfile.

## Conventions

- Keep `strict` TypeScript options and Python mypy strict checking enabled. Avoid `any`; use `unknown` and validate at boundaries.
- Validate environment variables at startup with Zod in Node services and Pydantic Settings in Python. Fail fast with variable names only; never print secret values.
- Use request IDs across service responses/logs. Emit structured JSON logs with `service`, `requestId`, severity, and safe error codes. Do not log request bodies, email content, credentials, or provider responses.
- Centralize errors and return the documented JSON error envelope. Do not return stack traces outside local development.
- Add focused unit tests for new behavior. Mock network, database, and provider boundaries unless an integration test explicitly requires local infrastructure.
- Keep routes small; place configuration, database access, logging, and error handling in dedicated modules. Gracefully drain HTTP servers and close clients on SIGINT/SIGTERM.
- Pin direct dependencies exactly and commit lockfiles. Update the version note in `docs/engineering-setup.md` for intentional upgrades.

## Security constraints

- Never commit `.env`, tokens, keys, personal data, or production dumps. `.env.example` must contain only conspicuous local placeholders.
- Enforce owner/account scoping in every future data access. Treat email bodies as untrusted content and future model output as untrusted input.
- Do not put Gmail credentials in Next.js, shared types, AI-service settings, logs, traces, or test fixtures.
- Any future external side effect requires a durable, exact-payload approval checked by Express. Graph state alone is never authorization.
- Keep health endpoints content-free and limited to safe service/dependency status.
