# MailPilot AI security and privacy design

**Status:** application authentication, Gmail OAuth/read-only synchronization, owner-scoped email listing, the Phase 5.1 OpenAI adapter, Phase 5.2 structured email analysis, Phase 5.3 suggestion-only reply drafting, Phase 5.4 evaluation integration, and the Phase 8.4 persistent read-only RAG workflow are implemented. Consequential task workflows, approvals, and send remain planned. This is an engineering baseline, not a substitute for Google OAuth verification, privacy counsel, or provider-specific data processing review.

## Security objectives

Protect user mailbox confidentiality; prevent cross-account retrieval; keep Gmail credentials unavailable to the browser and AI service; ensure no external email action happens without fresh approval of its exact payload; preserve recovery/auditability without logging email content; and allow disconnect and deletion to stop future processing and remove MailPilot-held copies.

## Data classification

| Class | Examples | Controls |
|---|---|---|
| Secrets | OAuth client secret, refresh tokens, signing keys, DB credentials, service credentials | Secret manager; envelope encryption for per-user refresh tokens; rotate; never log or send to browser/LLM. |
| Highly sensitive content | Email bodies, addresses, drafts, retrieved excerpts, checkpoints | TLS in transit, access-scoped DB roles, encryption at rest, minimized provider prompts, strict retention, content-free logs/traces, tenant checks. |
| Derived sensitive data | Embeddings, summaries, tasks, labels, retrieval scores | Treat at least as sensitive as source email; same account isolation and deletion rules. Embeddings are not anonymous. |
| Operational metadata | IDs, states, timing, error classes, model version | Limit identifiers and retention; redact or hash where possible; access-controlled traces. |

The RAG checkpointer persists run state, including retrieved evidence and the grounded response, in the AI-owned PostgreSQL schema. Checkpoint thread IDs are derived from the trusted user, conversation, and run UUIDs; those IDs are never accepted as caller-supplied storage keys. Checkpoint deserialization is restricted to an explicit application type allowlist. Trace logs contain only node names and opaque identifiers. Treat checkpoint rows as highly sensitive email data under the same database access, encryption-at-rest, and retention controls as the retrieval index.

The OpenAI API key belongs only to FastAPI's environment and is never returned to the browser, Express, Gmail, or logs. The adapter does not log prompts, mailbox content, authorization headers, or provider response bodies. Calls set `store: false`; this request option is not a substitute for an approved provider data-handling, region, and retention review before real mailbox content is sent.

The analysis route is available only through Express after session and CSRF checks. Express selects the email with both `emailId` and authenticated `userId`, sends bounded plain text and required metadata to FastAPI, and persists validated results through Prisma. FastAPI verifies a 60-second HMAC signature bound to method, route, request ID, timestamp, and exact request body; the shared signing secret stays in the API/AI environments. The email content is prompt data only: no tools, URLs, Gmail credentials, or Gmail mutations are made available to the model. Output dates and evidence are validated before Express stores the result, and failed validation does not persist the generated content.

Reply generation and edits are also available only through owner-scoped Express routes with session and CSRF validation. Express selects the target and bounded thread messages by authenticated owner and Gmail connection, and rechecks every source revision before storing. FastAPI treats email text as untrusted, has no tools or Gmail credentials, and can only return a validated suggestion. Both API boundaries verify source-message references and evidence quotes. Suggestions are stored with `suggestion` status; this feature has no send operation and does not expand the existing read-only Gmail permission.

## Application authentication and session lifecycle

- Express performs Google OpenID Connect sign-in with only `openid email`. It does not request Gmail scopes, offline access, or persist Google access/refresh tokens for this flow. Gmail authorization uses separate configuration and remains a distinct user action.
- Bind the authorization-code callback to a short-lived, signed HttpOnly transaction cookie containing random state, nonce, PKCE verifier, and an allowlisted return path. Validate state and nonce, use S256 PKCE, and validate the ID token through the discovered Google OIDC issuer. Identify accounts by the verified `sub` claim. Link by email only when Google is authoritative for it: a Gmail address, or a verified Workspace identity with an `hd` claim.
- Store a fresh, random 256-bit session token only as a SHA-256 hash in `app.sessions`. Sessions expire after eight hours, have no sliding extension, and are checked against expiry, revocation, and active user status on every protected Express request. Sign-out revokes the stored session.
- In production, set the host-only `__Host-mailpilot_session` cookie with `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`; do not set a `Domain`. The web/API deployment shares the host so Next.js server rendering can pass the cookie to Express for session validation. The Next proxy checks cookie presence only; protected layouts and Express perform authoritative session checks.
- Keep a separate CSRF token in a `Secure`, `SameSite=Strict`, JavaScript-readable cookie; store only its hash with the session. Cookie-authenticated writes require the same token in `x-csrf-token` and an exact configured `Origin` match. Clear both cookies when a session expires or is revoked.
- Production startup rejects local placeholder OIDC credentials/session secrets, non-HTTPS origins, and different web/API hosts. OAuth secrets and signing keys must never enter logs or browser responses.

## Gmail authorization and token lifecycle

- Use the server-side OAuth authorization code flow in Express with exact redirect URIs, a one-time random `state` bound to the authenticated session, validated callback and allowlisted return destination. Use a maintained server-side OAuth client library and review PKCE support/configuration as part of implementation.
- Request `gmail.readonly` only for read/sync MVP. Request `gmail.send` incrementally at the point the user turns on approved sending. Do not request broad `mail.google.com`, `gmail.modify`, or draft-write scope without an approved feature need. Google classifies Gmail scopes, and restricted-scope server storage/transmission may require verification and security assessment; track this as a launch gate: [scope guidance](https://developers.google.com/workspace/gmail/api/auth/scopes).
- Request offline access only because sync may run while the user is absent. Store the refresh token encrypted using envelope encryption with a managed KMS key; persist key version and encryption metadata. Re-encrypt on rotation. Keep access tokens short-lived in process memory where practical. Google documents offline refresh access and warns the refresh token may only be returned on initial authorization: [web server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server). During incremental consent, preserve the existing refresh token when the exchange omits a replacement; update the recorded granted-scope set only from a validated token response.
- Refresh only in Express. Handle invalid/revoked credentials as `reauth_required`; stop retries that cannot succeed. Never put token values in Next.js props, cookies, analytics, traces, exception messages, or database query logs.
- On disconnect, disable scheduled work first, attempt Google revocation, delete the stored credential regardless of revocation response, purge local data as specified, and show a truthful result. Google permits revocation and users may also revoke consent externally: [OAuth revocation endpoint](https://developers.google.com/identity/openid-connect/reference#revoke).

## Tenant isolation and authorization

- Express derives `userId` only from the validated session in `request.authContext`. Request bodies, query parameters, path IDs, `x-user-id`, role names, and audit actor labels never establish identity or privilege.
- Session lookup uses the hash of the opaque session cookie; sign-out and expiry revocation update by both session ID and the authenticated owner ID. Google identity updates are scoped by identity ID and owning user ID. Email summaries, analysis reads/generation, and reply-suggestion routes require authentication and owner-scoped Prisma predicates; write routes also require CSRF validation. Task, agent-run, pending-action, follow-up, and audit-log resource routes remain future work.
- The Next.js workspace route group protects `/`, `/inbox`, `/drafts`, `/approvals`, `/tasks`, `/archive`, `/agent`, `/activity`, and `/settings`. Its proxy redirects requests missing the session cookie; the workspace server layout asks Express to validate the session. The sign-in and health pages remain public, and cookie presence alone never grants access.
- Keep every future resource read and mutation in an Express service/data-access module. Build Prisma predicates from the authenticated `userId`, for example `{ id: requestedId, userId: authContext.userId }`; use the same owner predicate for `updateMany` and `deleteMany`, and derive `userId` server-side for creates. Return the same `404` for missing and foreign record IDs. Do not fetch by a browser-supplied ID and authorize afterward.
- The Prisma schema adds compound owner foreign keys from emails, analyses, chunks, runs, pending actions, tasks, and follow-ups to their parent records. They prevent cross-user relationships at the database layer; they do not replace owner predicates on reads and writes. `AuditActorType` is event attribution only. The `administrator` value is not an authorization role and no admin privilege is granted by submitting it.
- There is no role or privilege-escalation API in the current application. Add explicit server-managed authorization policy before adding administrative operations; never infer it from a client field or provider email domain.
- FastAPI accepts only authenticated internal calls. It scopes every ingestion, retrieval, deletion, and run by the authenticated account ID. If direct SQL access to application tables is ever added, use a restricted role and PostgreSQL row-level security/session context; do not give FastAPI access to `OAuthCredential`.
- Every chunk and embedding is account-scoped. Metadata filters are applied before candidate ranking. Test same Gmail IDs in two accounts and deliberately colliding thread/message IDs.
- Database roles are distinct for migrations, Express runtime, and AI runtime. Express runtime can access only needed app tables; agent runtime can write `ai` and has no token table access. Publicly routable database access is disabled.

## Approval and side-effect controls

- The AI service may propose `send_reply`; it cannot call Gmail. Express is the only Gmail action gateway.
- Approval shows recipients, subject, body, originating thread, source message, and account. Persist an immutable canonical payload hash and version. Any edit creates a new hash/version and requires a new approval decision.
- Approval is bound to user, account, action, payload hash, expiry, run, and idempotency key. Express revalidates all of these immediately before Gmail call. A rejected/expired/changed approval cannot be resumed.
- Require the send OAuth scope and active connection. Use an action execution record and idempotency key; if network outcome is ambiguous, reconcile before retry to avoid duplicate sends. No automatic retries of side effects based only on graph state.
- Add a per-user send rate limit and a clear UI confirmation. Do not allow model-provided recipient changes outside the visible reviewed action.

## LLM, retrieval, and prompt injection

- Treat all email text, quoted instructions, attachment names, and retrieved snippets as untrusted data. They cannot change system policy, call tools, request secrets, or approve actions.
- Use an allowlisted tool registry with typed input schemas. Read-only tools may retrieve account-scoped data. Mutating operations are unavailable to the model; the only send path is an approved Express callback.
- Separate instructions from quoted email data, escape/encode context in prompts, set output/token/time limits, validate model output against schemas, and validate every citation refers to a retrieved message in the same account.
- The Phase 8.3 graph exposes only `gmail_search` over owner-scoped synced/indexed data and `rag_answer`; user identity is injected from the signed internal request, omitted from model-controlled arguments, and checked against every returned source. Gmail OAuth tokens and direct Gmail API access remain Express-only.
- Ground answers in retrieved sources; if evidence is absent, say so. Do not invent dates, commitments, or people. Require evidence spans or chunk references for extracted tasks and factual claims.
- Send the minimum content needed to the configured provider. Do not claim Gemini or OpenAI offers a particular retention, region, structured output, or tool behavior until the selected model/API and account configuration are verified. Keep provider adapters and runtime capabilities explicit.
- Sanitize email HTML before display and render it in an inert context. Do not load remote images, execute scripts, follow links automatically, fetch arbitrary URLs, or fetch/process attachment contents; persist attachment metadata only. Enforce MIME depth, header/body size, decompression, and parsing limits.

## Web and service controls

- Use HTTPS/TLS externally and service-to-service; secure, HttpOnly, SameSite cookies; CSRF tokens and Origin validation on cookie-authenticated writes; CSP and output escaping; strict CORS allowlist; security headers; login/session rotation and revocation.
- Validate request body size and schema, rate limit OAuth, sync, agent runs, and approval decisions, and cap concurrent sync/LLM work per account.
- Internal service auth uses short-lived audience-restricted identity. Signed approval grants are one-action, one-version, time-limited, and replay protected. Health endpoints disclose no config or secrets.
- Validate redirect targets to prevent OAuth open redirects. Never trust forwarded identity headers from the public internet.

## Logging, tracing, and audit

- Carry `requestId`, `runId`, `accountId` (pseudonymous internal ID), and `traceId` across calls. Normal logs contain status, model/provider version, latency, usage/cost if known, retrieval IDs/ranks, and error class only.
- Do not log message bodies, OAuth codes/tokens, prompts, model responses, draft bodies, raw provider errors, or full Pydantic state. Diagnostic content capture, if ever enabled, requires explicit access/retention controls and a documented product reason.
- Audit connect/disconnect, scopes granted, sync/deletion, approval decision, and action result. Keep content out of audit events. Define audit retention separately from mailbox retention.
- Restrict tracing backend access, sample routine runs, and test that instrumentation redacts content. Store provider usage/cost only if the adapter actually returns it; mark estimates and pricing version separately.

## Data lifecycle

Document purpose, retention, data locations, subprocessors, model-provider handling, user deletion, backup expiration, and support access before production. Disconnecting stops new work, attempts to revoke the grant, and removes the credential; data retention follows the disclosed policy. A separate data-deletion request stops sync, revokes/disables the connection, purges app and AI tables/checkpoints, invalidates caches and search results, and lets backup copies expire on the documented schedule. Tombstones prevent stale outbox events from repopulating deleted content.

## Security verification plan

- Current API tests cover missing/expired sessions, forged user and administrator fields, foreign session IDs, owner-scoped session revocation, and Prisma owner predicates. The PostgreSQL integration suite checks cross-owner connection, email, analysis, chunk, run, pending-action, task, and follow-up relationships.
- Add route-level same-owner/foreign-owner list, detail, update, and delete tests for each resource as those endpoints are implemented. Keep the owner ID in every database predicate; return the same `404` for nonexistent and foreign IDs.
- Unit tests for approval hash/version/expiry checks, token encryption wrapper, log redaction, and idempotency.
- Integration tests with two tenants for list/detail/search/agent/task/approval and duplicate provider IDs.
- Adversarial tests for prompt injection inside sender content, malformed MIME/HTML, oversized messages, stale approval, replayed callback, revoked OAuth, model timeout, and outbox replay.
- Dependency, secret, and static scans in CI; independent review of OAuth scope compliance and approval-to-send flow before live sending.
