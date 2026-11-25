# Phase 14.3 — Production deployment record

**Date:** 2026-11-25  
**Status:** CI is green; deployment is waiting on Render billing setup and production configuration.  
**Target architecture:** Render Singapore baseline from [`render.yaml`](../render.yaml).

## Actions and verified results

- Published the workspace changes to `codex/phase-14-3-deployment` and opened [draft PR #1](https://github.com/Abhishek9885/MailPilot/pull/1). The default `main` branch was not changed.
- The first CI run stopped before setup because `astral-sh/setup-uv@v10` does not resolve. The workflow now pins the verified `v10.3.3` action commit.
- The second CI run passed dependency install, `npm audit`, lint, and typecheck. Eight Python pgvector integration tests failed because Prisma installs the extension under `app`, while the AI migration expects `public.vector`. A forward-only AI migration moves the relocatable extension to `public` before AI storage is created. CI run 3 passed: 341 tests (37 shared, 159 API, 13 web, and 132 Python), including live PostgreSQL/pgvector integration; dependency audit, lint, typecheck, Prisma validation, Node build, and FastAPI distribution build also passed.
- Render created Blueprint record `MailPilot` in the selected Personal Projects workspace. Its initial plan returned `need_payment_info` for the PostgreSQL database and all four application services. No service, database, Key Value instance, deploy, or production migration was provisioned.
- Current Blueprint plans estimate **$89.20/month** for one small always-on environment, before excess bandwidth, tax, custom domains, and model-provider usage. See the rate breakdown in [deployment architecture](deployment-architecture.md).
- Earlier local checks reported 328 tests passed and 13 PostgreSQL-dependent skips; lint, type checking, Prisma schema validation, Node production build, FastAPI wheel build, `npm audit`, and `npm audit --omit=dev` passed. The newly available hosted CI has since exposed the PostgreSQL migration issue above.
- No hosted smoke-test results are available. Sign-in, Gmail connection and sync, RAG, approval, and safe error handling have not been verified against deployed services.

## Blockers

1. Render requires billing information before planning the paid Postgres and service resources. The proposed baseline costs about **$89.20/month** at current listed rates. Review the exact Blueprint sync plan after billing is available.
2. Production Google OAuth redirect URIs, Render secrets, authenticated Redis endpoint/allowlist, restricted API and AI database roles, and migration-only credentials have not been configured or verified.
3. A staging environment and dedicated test mailbox are needed for live sign-in, Gmail sync, model-backed RAG, approval workflow, and safe-error smoke tests.

## Required before production

Follow the [CI/CD production runbook](ci-cd-production.md): get a green CI run, review and approve the paid Render resource plan, configure secrets in the Render dashboard, add least-privilege database roles and operator-only migration credentials, register the exact OAuth callback URIs, and complete a staging plus migration/restore rehearsal. Then merge a green commit, apply migrations using the documented operator-only procedure, approve the protected deployment, and run the smoke-test checklist with a dedicated account. Do not onboard production mailboxes until those checks pass.
