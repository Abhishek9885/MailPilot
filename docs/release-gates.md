# Phase 13.4 — Reliability and release gates

These gates are pre-deployment requirements. A test passing locally does not establish production readiness. Quality targets apply only to a frozen, reviewed, synthetic or properly consented test set with enough examples; current small fixtures are regression checks, not launch-quality evidence.

## Hard security and correctness gates

| Measure | Release threshold |
|---|---:|
| Cross-user records, sources, citations, or checkpoint access in adversarial tests | 0 |
| Approval bypass, execution with a changed/expired payload, duplicate provider action, or replayed action | 0 |
| Email-controlled content changing system policy, identity, permissions, or available tools | 0 in the adversarial regression suite |
| OAuth callback accepted without the same active initiating session and expected scope | 0 |
| Sensitive email content, OAuth credentials/codes, service signatures, or provider response bodies in normal logs | 0 |
| Required CI tests, type checks, lint, schema validation, and build failures | 0 |
| Unexplained skipped tests in a release candidate | 0; database-only skips must be run in the isolated integration environment before sign-off |

## Quality targets

Run on the same frozen gold set when comparing model, prompt, embedding, or retrieval changes. Report per-class/query-type failures as well as averages.

| Area | Target before enabling the feature for real users | Minimum evidence set |
|---|---|---:|
| Hybrid retrieval | Recall@5 ≥ 0.90 overall and ≥ 0.80 for every query family | 100 labeled queries, at least 15 per query family, grouped by account/thread |
| Citations | Citation correctness ≥ 0.99 and citation coverage ≥ 0.95 | 100 human-reviewed factual claims; every citation must resolve to an owned source |
| Faithfulness | Unsupported factual-claim rate ≤ 0.01; zero unsupported high-risk dates, recipients, money values, or approval state | 100 reviewed answers, including contradictory and adversarial sources |
| Abstention | False-answer rate ≤ 0.01 on no-evidence queries; answerable-query abstention rate ≤ 0.10 | 100 no-evidence and 100 answerable queries |
| Task/deadline extraction | Evidence support ≥ 0.99 and exact explicit-date accuracy ≥ 0.95 | 100 labeled items, with explicit, relative, ambiguous, and missing dates represented |
| Email classifier | Macro-F1 ≥ 0.80, per-class recall ≥ 0.70, and expected calibration error ≤ 0.10 | At least 200 held-out messages and 20 per class, split by related thread/duplicate family |

The classifier is experimental and must not authorize actions or silently classify mailbox data until these targets are met. If a feature does not meet its target, keep it disabled or visibly marked experimental; do not lower the target after observing a failing test set.

## Reliability and performance targets

- In fault-injection runs, at least 99 of 100 transient read-only calls/jobs recover within their configured bounded retry budget; all unrecovered work has a visible safe error or dead-letter record.
- Sync replay must not skip an unprocessed message or advance the Gmail history cursor past failed messages. Duplicate queue delivery must not duplicate stored messages, task records, or provider actions.
- Persistent LangGraph workflow tests must recover an interrupted run after a process/checkpointer restart, preserve owner/conversation/run isolation, and replay completed requests idempotently.
- At the agreed staging load, non-LLM API p95 latency must be ≤ 500 ms; RAG answer p95 must be ≤ 30 seconds; queue-to-first-sync-work p95 must be ≤ 60 seconds. Measure at least 1,000 representative operations after warm-up and report p50/p95/p99, errors, concurrency, and machine/service configuration.
- Provider and database timeouts must be bounded. A timeout with uncertain external outcome must enter reconciliation and must not automatically repeat a write.
- Set a numeric per-user/day and per-run provider spend ceiling, provider alerts, and a dated rate card before enabling real mailbox-scale AI. Request rate limits are not spend limits.

## Required test matrix

| Workflow | Required end-to-end path | Failure/recovery cases |
|---|---|---|
| Authentication | Sign in, establish session, enforce owner identity, revoke/sign out | expired/revoked session, CSRF/origin failure, OAuth state/session mismatch, unverified identity |
| Gmail | OAuth connection, initial sync, list owned mail, incremental sync | missing scope, rate limit, timeout, malformed/oversized MIME, cancellation, transient retry, deleted message, cursor recovery |
| RAG and LangGraph | authenticated request through Express/FastAPI, owner-scoped search, evidence assembly, grounded answer/citations | no evidence/abstention, injection, malformed tool args, service timeout, bounded retry, interrupted checkpoint, restart/resume, cross-user collision |
| Approval | proposal, exact snapshot review, approval, guarded mock execution, audit result | changed payload, wrong owner, expiry, replay, concurrent decision, duplicate submission, uncertain outcome/reconciliation |
| Tasks | source-linked task from analysis, owner-scoped edit/completion/dismissal | duplicate extraction, correction, missing/ambiguous due date, source revision change |
| Calendar | separate OAuth consent, event proposal, exact approval, mocked provider create/reconcile | missing scope, expired authorization, ambiguous timezone/DST, conflict, timeout, replay, duplicate execution |
| Database and migrations | validate schema, deploy all migrations to empty isolated PostgreSQL, deploy a second time, verify constraints/indexes, run owner-isolation integration tests | migration failure, duplicate delivery, restart recovery, rollback/restore procedure |

Use mock Google and AI providers in normal CI. A live provider smoke test is a separate controlled release activity, must use dedicated test accounts/data, and must never trigger an unapproved write.

## Release checklist

- [ ] `npm ci` and locked Python environment install complete without lockfile drift.
- [ ] The GitHub CI workflow passes for the exact release SHA, including the pgvector-backed PostgreSQL integration job; production approval is protected by an independent reviewer after migrations and recovery point are recorded.
- [ ] `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` pass.
- [ ] `npm run db:validate` passes; isolated PostgreSQL migration deploy/redeploy and `npm run test:db` pass.
- [ ] `npm audit` reports no Critical or High advisories; the production dependency tree is clean. Review and document any remaining Moderate or Low findings.
- [ ] AI PostgreSQL migrations, pgvector isolation, and persistent checkpointer restart/recovery tests pass against the isolated test database.
- [ ] The authentication, Gmail sync, RAG/LangGraph, approval, tasks, and Calendar test matrix passes; every skip is explained and resolved before release.
- [ ] Offline RAG, answer, abstention, extraction, classifier (if enabled), and cost/latency reports meet the targets above on the frozen release dataset.
- [ ] No open Critical or High security findings; security regressions, secret scanning, dependency scanning, and cross-tenant tests pass.
- [ ] Production secrets use a secret manager; token encryption rotation/restore is rehearsed; OAuth scopes and consent screen are reviewed; trusted proxy and allowed egress are verified.
- [ ] Redis persistence/limits, database backups and restore, queue dead letters, health checks, alerts, retention/deletion, and log access are verified.
- [ ] Calendar event writes remain disabled unless explicit approval flow, OAuth scope review, conflict/reconciliation tests, and release-owner sign-off are complete. Gmail send is not enabled by this release gate.
- [ ] Record build SHA, dataset/model/prompt versions, migration revision, measured results, operators, and rollback/disable steps. Do not deploy if a required gate is pending.

## Local execution record

Update this table with command, date, revision, pass/fail/skip counts, and the reason for each skip for every release candidate. Do not turn a skipped or infrastructure-blocked check into a pass.

This local run exercised HTTP routes and service/workflow boundaries with in-memory stores and provider fakes. It was not a full browser-to-PostgreSQL-to-Google end-to-end deployment run; the Render resources are not configured, no browser E2E harness was found, and the local Docker daemon was unavailable.

| Check | Result | Notes |
|---|---|---|
| `npm test` | Passed 2026-11-25 | 328 passed, 13 skipped: web 37; API 155 passed/4 skipped; shared 13; Python 123 passed/9 skipped. Every skip requires isolated PostgreSQL. |
| `npm run lint` | Passed 2026-11-25 | TypeScript ESLint and Python Ruff passed with a workspace-local uv cache. |
| `npm run typecheck` | Passed 2026-11-25 | TypeScript and Python mypy passed; 60 Python source files checked. |
| Production build | Passed 2026-11-25 | Shared/API/web build passed with Next.js 16.4.6. Next build required an elevated retry because Windows sandbox child-process spawning returned `EPERM`. |
| FastAPI distribution | Passed 2026-11-25 | `uv build --project apps/ai`; source distribution and wheel built successfully. |
| Prisma schema validation | Passed 2026-11-25 | `npm run db:validate`; this validates the schema, not live migration execution. |
| PostgreSQL migration/integration and AI checkpoint restart | Not run | Docker daemon unavailable in the local environment; requires isolated test PostgreSQL. |
| Security patch and npm audit | Passed 2026-11-25 | Next.js/eslint-config-next 16.4.6, Effect override 3.22.2, ESLint 10.15.0, and typescript-eslint 8.74.0; `npm audit` and `npm audit --omit=dev` report zero vulnerabilities. See [security audit](security-audit.md). |
| Load/latency targets | Not run | No representative staging load profile is configured. |
| Production migrations and PostgreSQL integration | Not run | Docker daemon is unavailable and no hosted Render database/least-privilege migration credentials are accessible. The 13 database-dependent tests remain skipped. |
| Live sign-in, Gmail sync, RAG, approval, and safe-error smoke tests | Not run | No production services, Google production redirect configuration, or dedicated test mailbox were available. No external actions were executed. |
| Production deployment | Not performed | Render CLI/API access is unavailable, GitHub deployment secrets and environment protection could not be inspected, and the local worktree has uncommitted changes. See the [deployment record](production-deployment-record.md). |
