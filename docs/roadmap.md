# MailPilot AI implementation roadmap

This plan tracks delivery from the Phase 1 repository foundation through a production-minded email operations agent. Phase 1 is implemented by this repository. Later-phase feature commands are introduced with the feature; commands marked **new in phase** are planned scripts and are not available yet.

## Phase 1 — Repository and service foundation (implemented)

**Deliver:** npm workspaces for Next.js, Express, and shared TypeScript; FastAPI package and `uv.lock`; Prisma schema and pgvector migration; Docker Compose PostgreSQL; environment validation; health endpoints; request IDs, structured logging, centralized errors, graceful shutdown; baseline tests and setup/security documentation. No OAuth, Gmail access, model calls, or background jobs.

**Acceptance criteria:** a clean checkout installs from committed lockfiles; all three applications start with local environment placeholders; web/API/AI liveness endpoints return 200 and request IDs; API/AI readiness endpoints return 200 only when PostgreSQL answers `SELECT 1`; the initial migration enables pgvector; lint, strict type checks, tests, build, and Prisma validation pass; `.env` and generated secrets remain untracked.

**Validation commands (PowerShell, repository root):**

```powershell
Copy-Item .env.example .env
npm ci
uv sync --project apps/ai --locked
docker compose up -d db
npm run db:generate
npm run db:deploy
npm run lint
npm run typecheck
npm test
npm run build
npm run db:validate
Invoke-RestMethod http://localhost:3000/api/health
Invoke-RestMethod http://localhost:4000/health/live
Invoke-RestMethod http://localhost:8000/health/live
Invoke-RestMethod http://localhost:4000/health/ready
Invoke-RestMethod http://localhost:8000/health/ready
docker compose exec -T db psql -U mailpilot -d mailpilot -c "SELECT extname FROM pg_extension WHERE extname = 'vector';"
```

Start the apps in a separate terminal with `npm run dev:all`. Docker Desktop and registry access are manual prerequisites; see [README.md](../README.md).

## Phase 2 — Identity, Gmail authorization, and bounded read-only sync

**Deliver:** establish user/session identity; implement Express-owned OAuth state/callback, encrypted refresh-token storage, narrow read-only Gmail authorization, bounded resumable initial sync, normalized messages/threads, sync status, transactional outbox, owner-scoped browse/detail routes, disconnect, and deletion. Do not request send scope in this phase.

**Acceptance criteria:** OAuth state is single-use and tied to the initiating session; tokens never reach the browser, logs, or FastAPI; configured limits cap sync work; retries and duplicate pages do not duplicate messages; revoked authorization stops sync and signals reauthentication; deletion stops new work and removes stored content/index requests idempotently; cross-account IDs do not disclose ownership.

**Validation commands:**

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run db:validate
npm run test:e2e -- --grep "OAuth|sync|disconnect|tenant isolation"
```

`test:e2e` is a **new in phase** Playwright script. Automated tests use a Gmail API fake. Real OAuth smoke testing requires a manually configured Google Cloud project, consent screen, allowed redirect URI, and test account; it is not part of routine CI.

## Phase 3 — Message ingestion, embeddings, and hybrid retrieval

**Deliver:** versioned message normalization and chunking; the Phase 6.1 provider-neutral embedding adapter; AI-owned schema/migrations; PostgreSQL full-text and pgvector retrieval with account/date/sender/label filters; exact source references; deletion/tombstones; retrieval evaluation set and trace hooks. Production processing remains gated on data-handling approval. Keep workers within the existing API/AI boundaries unless measured load justifies a queue.

**Acceptance criteria:** replays and stale source revisions are safe; every vector records model/version/dimension and refuses incompatible queries; metadata filters apply before ranking; keyword, vector, and hybrid modes return message/chunk provenance; deleted content is excluded immediately and stale events cannot restore it; retrieval quality and latency are measured against a versioned dataset; failed embedding work is visible and retryable.

**Validation commands:**

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run db:validate
npm run eval:retrieval -- --dataset eval/retrieval-v1.jsonl
npm run test:e2e -- --grep "index|search|deletion"
```

`eval:retrieval` and `test:e2e` are **new in phase** scripts. Phase 6.1 records the initial model and adapter limits; approve data retention and processing region before sending real mailbox content to the provider.

## Phase 4 — Email understanding, prioritization, and task candidates

**Deliver:** provider-neutral LLM adapter and structured extraction schemas; summaries/category/priority signals; tasks and deadline candidates with evidence and confidence; user correction/review UI; scikit-learn classification baseline; evaluation for extraction quality, classification, answer grounding, latency, and model cost; redacted tracing and bounded failure recovery.

**Acceptance criteria:** all model output is validated and evidence-linked; unknown dates remain unknown; user-visible priority and task candidates can be corrected; the classifier is compared to a documented simple baseline with grouped train/test splits and per-class metrics; evaluation records model/prompt/data versions and cost/latency; provider timeout or invalid output preserves source mail and yields a retryable or review-needed state; traces contain no email bodies, tokens, or prompts.

**Validation commands:**

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run eval:understanding -- --dataset eval/understanding-v1.jsonl
npm run eval:classifier -- --dataset eval/classification-v1.jsonl
npm run test:e2e -- --grep "understanding|tasks|source references"
```

The evaluation and end-to-end scripts are **new in phase**. Phase 5.1 now provides the first adapter through OpenAI's Responses API, with GPT-6.1 Sol as a configurable evaluation candidate. This does not make the model choice final: provider capabilities and quality/cost trade-offs still need measurement against the evaluation set.

Phase 5.2 now implements the first bounded analysis flow: Express loads an owned email, FastAPI returns schema-constrained categories, priority, summary, action/deadline/commitment/event candidates, and Express persists the validated result with source revision, schema version, provider, and actual model version. Dates and event ordering are validated, evidence excerpts must occur in the source email, and malformed output is rejected without logging or persisting its contents. The email is presented as untrusted data with no model tools or Gmail actions.

Phase 5.3 adds owner-scoped, editable reply suggestions generated from the selected email and up to seven recent messages in its thread. Source references and evidence quotes are validated at both service boundaries, missing context returns no saved draft, and email instructions remain untrusted. Suggestions are persisted as suggestions; no Gmail send/write behavior is included.

Phase 5.4 connects synced-email analysis to the inbox panel, including saved-result loading, retry, first analysis, and explicit re-analysis. The synthetic, manually reviewed eight-case set and scorer are in place. A measured model-quality/latency/cost baseline remains pending because the local environment has no configured `OPENAI_API_KEY` or token pricing rates; record that run before making model-quality or launch claims.

## Phase 5 — LangGraph workflows, durable approval, and approved send

The Phase 8.1 read-only RAG graph is the foundation for this later workflow. This phase adds persistent state, bounded tools, and the approval-gated action path; it does not change the read-only behavior delivered in Phase 8.1.

**Deliver:** bounded LangGraph stateful workflow; PostgreSQL checkpoint persistence; typed tools and bounded tool budgets; approval interrupts; durable approval/action rows in Express; exact-payload hash/version checks; approval UI; incrementally authorized `gmail.send`; Express-only send gateway; idempotent execution and reconciliation; restart/resume tests.

**Acceptance criteria:** graph checkpoints survive process restart and are owner-scoped; tool arguments cannot expand authorized account/thread scope; approval binds to the exact recipient, subject, body, and thread version; edits require new approval; rejected, expired, replayed, or mismatched actions cannot send; FastAPI never receives OAuth credentials; ambiguous send outcomes are reconciled before retry; traces capture tool choice and outcome without sensitive content.

**Validation commands:**

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run db:validate
npm run eval:agent -- --dataset eval/agent-v1.jsonl
npm run test:e2e -- --grep "approval|resume|send|replay"
```

`eval:agent` and `test:e2e` are **new in phase** scripts. Tests use a fake Gmail sender; enabling real sending requires OAuth scope verification and a controlled manual release check.

## Phase 6 — Production readiness and measured operations

**Deliver:** deployment configuration; metrics, dashboards, alerts, quotas, and runbooks; backup/restore and deletion-SLA drills; key rotation; dependency/secret/static scans; staging load/recovery profile; quality/latency/cost release gates. Add Redis/BullMQ or Gmail push only when measured lag, throughput, or reliability needs justify them.

**Acceptance criteria:** approved SLOs and quality thresholds; repeatable restore and recovery evidence; alerting and replay procedures; deletion covers source records, indexes, checkpoints, caches, and backup expiry; tenant-isolation and no-unapproved-send suites pass; dependency and secret scans have reviewed results; scaling choices are supported by recorded measurements.

### Phase 6.1 — Embedding adapter

The provider-neutral Python embedding contract and OpenAI adapter are implemented. The initial choice is `text-embedding-3-small` at 1,536 dimensions, with bounded input tokenization, sequential batching, safe transient retries, typed usage/cost metadata, and model-version validation. This phase does not add indexing, vector storage, retrieval, or RAG. See [the model and adapter decision](embedding-provider.md).

### Phase 6.2 — Email chunking

The Python chunker deterministically cleans one email message at a time, falls back from plain text to HTML text extraction, removes common quoted-reply history, and splits long messages without combining thread messages. Each output carries owner and source metadata, source revision, cleaner/chunker versions, a content hash, and offsets into the canonical cleaned text. Duplicate delivery of the same source revision is idempotent; conflicting copies fail with a safe error. This phase does not persist chunks or call the embedding provider.

### Phase 6.3 — pgvector storage

The AI-owned PostgreSQL schema persists 1,536-dimensional embeddings with model/provider/version metadata and source chunk revision/hash metadata. A composite user/chunk foreign key cascades deletion, row-level security and explicit SQL owner predicates scope all reads/writes, and nearest-neighbor queries filter to the requested embedding version and current active chunk revision. The selected cosine HNSW index is backed by owner/version B-tree filtering. Transactional SQL migrations are checksum-tracked separately from Prisma and reject modified/missing applied files. Tests cover insertion, nearest neighbors, owner filtering, duplicates, model changes, deletion, and migration replay/checksums using an isolated `MAILPILOT_TEST_DATABASE_URL` ending in `_test`.

**Validation commands:**

```powershell
npm ci
uv sync --project apps/ai --locked
npm run lint
npm run typecheck
npm test
npm run build
npm run db:validate
npm run test:e2e
npm run eval:release
npm run security:check
npm run ops:load -- --profile=staging
npm run ops:restore-drill -- --profile=staging
npm run ops:recovery-drill -- --profile=staging
```

End-to-end, evaluation, security, and operations scripts are **new in phase** and must wrap the chosen CI/hosting/security tooling. Never run recovery or load drills against production data.

## Phase 8.1 — Read-only LangGraph foundation (implemented)

**Deliver:** typed and validated request state; separate interpret, retrieve, assemble, answer, abstain, and response nodes; conditional evidence routing; graph-scoped runtime dependency injection; generated Mermaid topology. No mailbox tools, checkpoint persistence, or side effects are enabled in this foundation.

**Acceptance criteria:** invalid inputs stop before retrieval; retrieval preserves existing owner scoping; empty or over-budget evidence routes to a grounded abstention; successful answers retain validated citations; graph output exposes only the response schema; retrieved email content remains untrusted and no model reasoning is stored or returned.

The current graph and visualization are in `apps/ai/src/mailpilot_ai/rag/workflow.py` and `docs/rag-workflow.mmd`. The durable approval workflow below remains a separate future phase.

## Phase 8.2 — Intent and bounded planning (implemented)

**Deliver:** separate structured intent-classification, plan-generation, and plan-validation nodes for email search, summarization, action-item extraction, drafting, and permitted task-candidate proposals. Plans use an explicit operation allowlist, a five-step cap, and fixed acyclic sequences. Ambiguous/low-confidence requests route to clarification.

**Acceptance criteria:** invalid operations or sequences fail closed before retrieval; task plans only propose candidates and never mutate task records; drafting is routed to the existing selected-thread draft service rather than executed by the read-only graph; user requests containing quoted email text cannot turn that content into instructions; no free-form model reasoning is stored or returned.

## Phase 8.3 - Approved read-only tool routing and recovery (implemented)

**Deliver:** a fixed LangGraph tool registry with `gmail_search` over the owner-scoped synced/indexed mailbox and grounded `rag_answer`; strict Pydantic argument schemas; trusted user identity injected outside model arguments; per-tool read permissions; bounded timeouts/retries; safe structured errors and abstention fallback. FastAPI never receives Gmail OAuth tokens or direct Gmail API access.

**Acceptance criteria:** unknown or mutating tools are rejected; malformed arguments fail before tool execution; every invocation carries and verifies the same user identity; cross-user sources fail closed; empty search returns no evidence; retry and timeout limits are enforced; tool failures return a safe abstention; adversarial email text remains untrusted evidence.

## Phase 8.4 — Persistent read-only workflow (implemented)

**Deliver:** the pinned LangGraph PostgreSQL checkpointer in the AI-owned schema; stable conversation and run UUIDs; opaque owner-scoped checkpoint threads; exact request binding for resume; advisory-lock serialization; bounded recursion; safe node traces; and recovery after a process restart.

**Acceptance criteria:** completed runs replay idempotently; interrupted runs resume only with the same owner, conversation, run ID, and normalized payload; implicit or altered resumes fail closed; cross-user requests map to different checkpoint threads; checkpoint deserialization uses an explicit type allowlist; traces contain no email content or model reasoning; no consequential action can run before the Phase 9 approval path exists.

The implementation and optional PostgreSQL restart test are described in [agent-workflow-persistence.md](agent-workflow-persistence.md).

## Prioritized implementation checklist

1. **P0:** confirm user/account cardinality, supported Google account types, mailbox import cap, retention and deletion SLA, launch geography, and session identity.
2. **P0:** confirm Google OAuth scopes, verification/security-assessment path, consent wording, and test-account setup before connecting real users.
3. **P0:** decide production host/region, PostgreSQL/pgvector version, encryption/KMS, secret manager, backup policy, internal service authentication, and trace backend.
4. **P1:** implement read-only authorization and bounded sync with outbox/recovery and tenant-isolation tests.
5. **P1:** approve email redaction/data-handling policy and provider region/retention terms for the selected embedding adapter.
6. **P1:** deliver versioned indexing, hybrid retrieval, source references, deletion, and a golden retrieval evaluation set.
7. **P2:** implement structured extraction, deadline/task candidates, classifier baseline, review flows, and measured quality gates.
8. **P2:** add LangGraph persistence, tool limits, durable approval, and Express-only send gateway.
9. **P2:** complete security, OAuth verification, restore/deletion tests, and operational review before limited release.

## Unresolved decisions

- SaaS or internal deployment; user-to-account cardinality; supported Google account types.
- Initial date window and hard message cap; retention period and deletion SLA including backups.
- Login/session provider and cookie/CSRF scheme; Google verification owner and schedule.
- Production data region/retention, embedding index/model switch policy, LLM evaluation candidate, usage telemetry, and provider change policy.
- Email-body redaction, quoted-history/signature handling, taxonomy, priority policy, and timezone rules.
- Evaluation dataset consent process, sample size, quality thresholds, latency and cost SLOs.
- Production cloud/region, database sizing/index strategy, key rotation, audit retention, and triggers for Redis/BullMQ or Gmail push.
