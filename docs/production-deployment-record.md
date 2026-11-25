# Phase 14.3 — Production deployment record

**Date:** 2026-11-25  
**Status:** Not deployed; blocked before provisioning production resources.  
**Target architecture:** Render Singapore baseline from [`render.yaml`](../render.yaml).

## Actions and verified results

- No Render resources were created, no deployment was triggered, no production database migrations were applied, and no external action was executed.
- Local release checks on the patched dependency candidate: 328 tests passed and 13 PostgreSQL-dependent tests skipped; lint, type checking, Prisma schema validation, Node production build, FastAPI wheel build, `npm audit`, and `npm audit --omit=dev` passed. The full test breakdown is in [release gates](release-gates.md).
- The Node production dependency tree and the full npm dependency tree report zero vulnerabilities after updating Next.js and its lint tooling.
- No hosted smoke-test results are available. Sign-in, Gmail connection and sync, RAG, approval, and safe error handling have not been verified against production services.

## Blockers

1. Render CLI is not installed, no Render API credentials are available to the local deployment process, and no `RENDER_*` environment variables are configured. The Windows computer-use helper was unavailable, so the Render Dashboard session could not be inspected.
2. GitHub CLI is not installed. The local `main` worktree contains uncommitted code and configuration changes; they are not the exact pushed commit that the release workflow deploys. The GitHub remote check through the configured local proxy did not connect.
3. Docker Desktop's Linux daemon is stopped. The 13 PostgreSQL-dependent tests, live migrations, database-backed checkpointer restart, and restore/recovery checks remain unverified locally.
4. Production Google OAuth redirect URIs, Render secrets, authenticated Redis endpoint/allowlist, restricted API and AI database roles, and migration-only credentials have not been configured or verified.
5. No staging environment or dedicated test mailbox is available for live sign-in, Gmail sync, model-backed RAG, approval workflow, or safe-error smoke tests.

## Required before a production attempt

Follow the [CI/CD production runbook](ci-cd-production.md): provision and review the paid Render resources, validate and sync the Blueprint, configure GitHub branch protection and the `production` environment secrets, add least-privilege database roles and provider secrets in the secret manager, register the exact OAuth callback URIs, and perform a staging plus migration/restore rehearsal. Then publish a green commit, apply migrations using the documented operator-only procedure, approve the protected deployment, and run the smoke-test checklist with a dedicated account. Do not onboard production mailboxes until those checks pass.
