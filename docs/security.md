# MailPilot AI security and privacy design

**Status:** application authentication, Gmail OAuth/read-only synchronization, owner-scoped email listing, the Phase 5.1 OpenAI adapter, Phase 5.2 structured email analysis, Phase 5.3 suggestion-only reply drafting, Phase 5.4 evaluation integration, the Phase 8.4 persistent read-only RAG workflow, persisted approval lifecycle, source-linked tasks, approval-gated Calendar event creation, Phase 12.2 user-memory management, and the Phase 13.3 source-level security audit are implemented. Phase 12.1 records the memory design. Calendar event creation is disabled by default; Gmail sending is not implemented. This is an engineering baseline, not a substitute for Google OAuth verification, privacy counsel, or provider-specific data processing review.

## Security objectives

Protect user mailbox confidentiality; prevent cross-account retrieval; keep Gmail credentials unavailable to the browser and AI service; ensure no external email action happens without fresh approval of its exact payload; preserve recovery/auditability without logging email content; and allow disconnect and deletion to stop future processing and remove MailPilot-held copies.

## Data classification

| Class | Examples | Controls |
|---|---|---|
| Secrets | OAuth client secret, refresh tokens, signing keys, DB credentials, service credentials | Secret manager; envelope encryption for per-user refresh tokens; rotate; never log or send to browser/LLM. |
| Highly sensitive content | Email bodies, addresses, drafts, retrieved excerpts, checkpoints, approved user-memory values | TLS in transit, access-scoped DB roles, encryption at rest, minimized provider prompts, strict retention, content-free logs/traces, tenant checks. |
| Derived sensitive data | Embeddings, summaries, tasks, labels, retrieval scores, memory provenance | Treat at least as sensitive as source email; same account isolation and deletion rules. Embeddings are not anonymous. |
| Operational metadata | IDs, states, timing, error classes, model version | Limit identifiers and retention; redact or hash where possible; access-controlled traces. |

The RAG checkpointer persists run state, including retrieved evidence and the grounded response, in the AI-owned PostgreSQL schema. Checkpoint thread IDs are derived from the trusted user, conversation, and run UUIDs; those IDs are never accepted as caller-supplied storage keys. Checkpoint deserialization is restricted to an explicit application type allowlist. Trace logs contain only node names and opaque identifiers. Treat checkpoint rows as highly sensitive email data under the same database access, encryption-at-rest, and retention controls as the retrieval index.

The OpenAI API key belongs only to FastAPI's environment and is never returned to the browser, Express, Gmail, or logs. The adapter does not log prompts, mailbox content, authorization headers, or provider response bodies. Calls set `store: false`; this request option is not a substitute for an approved provider data-handling, region, and retention review before real mailbox content is sent.

The analysis route is available only through Express after session and CSRF checks. Express selects the email with both `emailId` and authenticated `userId`, sends bounded plain text and required metadata to FastAPI, and persists validated results through Prisma. FastAPI verifies a 60-second HMAC signature bound to method, route, request ID, timestamp, and exact request body; the shared signing secret stays in the API/AI environments. The email content is prompt data only: no tools, URLs, Gmail credentials, or Gmail mutations are made available to the model. Output dates and evidence are validated before Express stores the result, and failed validation does not persist the generated content.

Reply generation and edits are also available only through owner-scoped Express routes with session and CSRF validation. Express selects the target and bounded thread messages by authenticated owner and Gmail connection, and rechecks every source revision before storing. FastAPI treats email text as untrusted, has no tools or Gmail credentials, and can only return a validated suggestion. Both API boundaries verify source-message references and evidence quotes. Suggestions are stored with `suggestion` status; this feature has no send operation and does not expand the existing read-only Gmail permission.

## Application authentication and session lifecycle

- Express performs Google OpenID Connect sign-in with only `openid email`. It does not request Gmail or Calendar scopes, offline access, or persist Google access/refresh tokens for this flow. Gmail and Calendar authorization each use separate configuration and remain distinct user actions.
- Bind the authorization-code callback to a short-lived, signed HttpOnly transaction cookie containing random state, nonce, PKCE verifier, initiating session ID, and an allowlisted return path. Validate state and nonce, require the same current active initiating session, use S256 PKCE, and validate the ID token through the discovered Google OIDC issuer. Identify accounts by the verified `sub` claim. Link by email only when Google is authoritative for it: a Gmail address, or a verified Workspace identity with an `hd` claim.
- Store a fresh, random 256-bit session token only as a SHA-256 hash in `app.sessions`. Sessions expire after eight hours, have no sliding extension, and are checked against expiry, revocation, and active user status on every protected Express request. Sign-out revokes the stored session.
- In production, set the host-only `__Host-mailpilot_session` cookie with `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`; do not set a `Domain`. The web/API deployment shares the host so Next.js server rendering can pass the cookie to Express for session validation. The Next proxy checks cookie presence only; protected layouts and Express perform authoritative session checks.
- Keep a separate CSRF token in a `Secure`, `SameSite=Strict`, JavaScript-readable cookie; store only its hash with the session. Cookie-authenticated writes require the same token in `x-csrf-token` and an exact configured `Origin` match. Clear both cookies when a session expires or is revoked.
- Production startup rejects local placeholder OIDC credentials/session secrets, non-HTTPS origins, and different web/API hosts. OAuth secrets and signing keys must never enter logs or browser responses.

## Gmail authorization and token lifecycle

- Use the server-side OAuth authorization code flow in Express with exact redirect URIs, a one-time random `state` bound to the authenticated session, validated callback and allowlisted return destination. Gmail and Calendar callbacks require the same active initiating session before code exchange. Reject unverified Google identities and token responses missing the requested Gmail read-only scope. Use a maintained server-side OAuth client library and review PKCE support/configuration as part of implementation.
- Request `gmail.readonly` only for read/sync MVP. Request `gmail.send` incrementally at the point the user turns on approved sending. Do not request broad `mail.google.com`, `gmail.modify`, or draft-write scope without an approved feature need. Google classifies Gmail scopes, and restricted-scope server storage/transmission may require verification and security assessment; track this as a launch gate: [scope guidance](https://developers.google.com/workspace/gmail/api/auth/scopes).
- Request offline access only because sync may run while the user is absent. Store the refresh token encrypted using envelope encryption with a managed KMS key; persist key version and encryption metadata. Re-encrypt on rotation. Keep access tokens short-lived in process memory where practical. Google documents offline refresh access and warns the refresh token may only be returned on initial authorization: [web server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server). During incremental consent, preserve the existing refresh token when the exchange omits a replacement; update the recorded granted-scope set only from a validated token response.
- Refresh only in Express. Handle invalid/revoked credentials as `reauth_required`; stop retries that cannot succeed. Never put token values in Next.js props, cookies, analytics, traces, exception messages, or database query logs.
- On disconnect, disable scheduled work first, attempt Google revocation, delete the stored credential regardless of revocation response, purge local data as specified, and show a truthful result. Google permits revocation and users may also revoke consent externally: [OAuth revocation endpoint](https://developers.google.com/identity/openid-connect/reference#revoke).

## Google Calendar authorization and event lifecycle

- Calendar OAuth is separate from application sign-in and Gmail. Express requests only the Calendar event scope needed for primary-calendar event access (`https://www.googleapis.com/auth/calendar.events.owned`) plus OAuth identity scopes. Store the Calendar refresh token in its own owner-scoped connection row with encryption; never send it to Next.js or FastAPI. Production requires a non-placeholder base64-encoded 32-byte Calendar token key even while event writes are disabled. Reconnection is required after revocation or invalid authorization.
- Keep `GOOGLE_CALENDAR_EVENTS_ENABLED=false` by default. An event can be created only through Express after it has a persisted immutable proposal, the owner approves the displayed snapshot hash, and the execution route rechecks owner, expiry, approval state, current source revision/evidence, active Calendar connection, and granted scope immediately before calling Google. The feature flag is a second server-side gate.
- Event proposals bind the local wall time, resolved instant, and IANA timezone. Reject invalid zones, DST gaps, and ambiguous repeated local times instead of guessing. Check the requested interval for known primary-calendar conflicts and fail closed. This preflight cannot prevent an unrelated client from creating a conflicting event after the check.
- Use a deterministic Google event ID derived from the durable execution key and private verification properties tied to the exact payload hash and source message. Do not add attendees; use `sendUpdates=none`. On uncertain provider outcomes, require reconciliation before retry. Do not create/update/cancel events from model output or graph state; event updates and cancellation are not supported.
- Audit connection/disconnection, approval decisions, execution attempts/results, and reconciliation with safe metadata only. Never log event content, source quotes, OAuth codes/tokens, or provider response bodies.

## User memory privacy (Phase 12.2)

Memory defaults to disabled. Enabling it records a versioned consent event. Creating or correcting an item requires an explicit user request, CSRF validation, and enabled consent; connecting Gmail or encountering email text never implies consent. The UI accepts bounded preference values, structured recurrence, or a short user-entered fact. A selected email is provenance only; no extraction path can write a memory. Policy-like phrases and credential terms are rejected by shared input validation, and memory is never interpreted as an instruction or authorization for external actions.

All database access includes the authenticated `userId`. Source emails are constrained by a same-owner foreign key with cascade deletion. A changed source revision marks a memory stale; stale and expired rows are excluded from retrieval. Retrieval returns no more than 10 items/2,000 characters and ranks by deterministic lexical overlap. Pause suppresses retrieval while retaining current expiry; turn-off deletes all memory and clears consent. Expired data is pruned after 30 days on access to the memory API. Audit metadata records operation, owner, request, and safe counts/status only; it does not include values or email content.

The retrieval endpoint is currently used for a UI preview only. No memory value is sent to FastAPI or persisted in LangGraph checkpoints. A future model handoff requires a renewed purpose notice if needed and must pass only a selected transient subset, marked as untrusted data rather than instructions. User deletion and source-email deletion cascade memory rows.

## Tenant isolation and authorization

- Express derives `userId` only from the validated session in `request.authContext`. Request bodies, query parameters, path IDs, `x-user-id`, role names, and audit actor labels never establish identity or privilege.
- Session lookup uses the hash of the opaque session cookie; sign-out and expiry revocation update by both session ID and the authenticated owner ID. Google identity updates are scoped by identity ID and owning user ID. Email summaries, analysis reads/generation, reply-suggestion routes, tasks, action proposals, and Calendar connections require authentication and owner-scoped predicates; write routes also require CSRF validation. Keep agent-run and follow-up resource scope explicit as those endpoints are added.
- The Next.js workspace route group protects `/`, `/inbox`, `/drafts`, `/approvals`, `/tasks`, `/archive`, `/agent`, `/activity`, and `/settings`. Its proxy redirects requests missing the session cookie; the workspace server layout asks Express to validate the session. The sign-in and health pages remain public, and cookie presence alone never grants access.
- Keep every future resource read and mutation in an Express service/data-access module. Build Prisma predicates from the authenticated `userId`, for example `{ id: requestedId, userId: authContext.userId }`; use the same owner predicate for `updateMany` and `deleteMany`, and derive `userId` server-side for creates. Return the same `404` for missing and foreign record IDs. Do not fetch by a browser-supplied ID and authorize afterward.
- The Prisma schema adds compound owner foreign keys from emails, analyses, chunks, runs, pending actions, tasks, and follow-ups to their parent records. They prevent cross-user relationships at the database layer; they do not replace owner predicates on reads and writes. `AuditActorType` is event attribution only. The `administrator` value is not an authorization role and no admin privilege is granted by submitting it.
- There is no role or privilege-escalation API in the current application. Add explicit server-managed authorization policy before adding administrative operations; never infer it from a client field or provider email domain.
- FastAPI accepts only authenticated internal calls. It scopes every ingestion, retrieval, deletion, and run by the authenticated account ID. If direct SQL access to application tables is ever added, use a restricted role and PostgreSQL row-level security/session context; do not give FastAPI access to `OAuthCredential`.
- Every chunk and embedding is account-scoped. Metadata filters are applied before candidate ranking. Test same Gmail IDs in two accounts and deliberately colliding thread/message IDs.
- Database roles are distinct for migrations, Express runtime, and AI runtime. Express runtime can access only needed app tables; agent runtime can write `ai` and has no token table access. Publicly routable database access is disabled.

## Approval and side-effect controls

- The model and LangGraph may produce evidence-backed proposals but cannot call Gmail or Calendar. Express is the only provider side-effect gateway. Gmail sending is not implemented.
- Approval shows the exact Calendar event title, local and resolved times, timezone, location, source evidence, and destination calendar. Persist an immutable canonical snapshot and hash. Any edit requires a new proposal and approval.
- Approval is bound to user, action, payload hash, expiry, source evidence, and idempotency key. Express revalidates the exact snapshot and owner immediately before execution. A rejected, expired, changed, or unauthorized approval cannot execute.
- Calendar creation requires the separate active Calendar connection, its event scope, the feature flag, and a deterministic provider idempotency key. Check conflicts before insert and reconcile any uncertain result before retry. Do not retry side effects based only on graph state.
- No attendees or invitations are added. Event updates and cancellations are unsupported. Do not allow model-provided event details outside the visible reviewed action.

## LLM, retrieval, and prompt injection

- Treat all email text, quoted instructions, attachment names, and retrieved snippets as untrusted data. They cannot change system policy, call tools, request secrets, or approve actions.
- Use an allowlisted tool registry with typed input schemas. Read-only tools may retrieve account-scoped data. Mutating operations are unavailable to the model; the only send path is an approved Express callback.
- Separate instructions from quoted email data, escape/encode context in prompts, set output/token/time limits, validate model output against schemas, and validate every citation refers to a retrieved message in the same account.
- The Phase 8.3 graph exposes only `gmail_search` over owner-scoped synced/indexed data and `rag_answer`; user identity is injected from the signed internal request, omitted from model-controlled arguments, and checked against every returned source. Gmail OAuth tokens and direct Gmail API access remain Express-only.
- Ground answers in retrieved sources; if evidence is absent, say so. Do not invent dates, commitments, or people. Require evidence spans or chunk references for extracted tasks and factual claims.
- Send the minimum content needed to the configured provider. Do not claim Gemini or OpenAI offers a particular retention, region, structured output, or tool behavior until the selected model/API and account configuration are verified. Keep provider adapters and runtime capabilities explicit.
- Sanitize email HTML before display and render it in an inert context. Do not load remote images, execute scripts, follow links automatically, fetch arbitrary URLs, or fetch/process attachment contents; persist attachment metadata only. Enforce MIME depth, header/body size, decompression, and parsing limits. The Express Gmail client caps streamed success responses at 8 MiB and error bodies at 64 KiB before parsing or rate-limit inspection.

## Web and service controls

- Use HTTPS/TLS externally and service-to-service; secure, HttpOnly, SameSite cookies; CSRF tokens and Origin validation on cookie-authenticated writes; CSP and output escaping; strict CORS allowlist; security headers; login/session rotation and revocation.
- Validate request body size and schema. A Redis-backed limiter applies a global 300 requests/5 minute IP budget and route budgets for OAuth (20/10 minutes), AI generation (10/minute), sync (3/10 minutes), and action proposals/decisions (12/minute), with matching session budgets when a valid session cookie is present. It hashes limiter subjects, returns `Retry-After`, and fails closed with a safe 503 when Redis is unavailable. `TRUST_PROXY_HOPS` must be set to the number of trusted ingress hops; configure the edge to overwrite forwarded headers. These initial limits are not a provider spend cap or load-tested capacity target.
- Internal service auth uses short-lived audience-restricted identity. Signed approval grants are one-action, one-version, time-limited, and replay protected. Health endpoints disclose no config or secrets.
- Validate redirect targets to prevent OAuth open redirects. Never trust forwarded identity headers from the public internet.

## Logging, tracing, and audit

- Carry `requestId` across Express and FastAPI, and `runId` through persistent LangGraph execution. Normal logs contain status, safe node/tool names, model/provider version, latency, token usage/cost if known, and error class only. Do not add account IDs unless a reviewed operational need and pseudonymization policy require them.
- Do not log message bodies, OAuth codes/tokens, prompts, model responses, draft bodies, raw provider errors, service signatures, or full Pydantic state. API redaction covers authorization/cookie/service-signature headers and sensitive fields; a regression test verifies signature redaction. Diagnostic content capture, if ever enabled, requires explicit access/retention controls and a documented product reason.
- Audit Gmail/Calendar connect/disconnect, scopes granted, sync/deletion, approval decision, action result, and Calendar reconciliation. Keep event and email content out of audit events. Define audit retention separately from mailbox retention.
- Restrict log and tracing backend access, sample routine runs, and test that instrumentation redacts content. Store provider usage/cost only if the adapter actually returns it; mark estimates and pricing version separately. Current runtime emits JSON to stdout and does not export traces to LangSmith or another SaaS. See [observability operations](observability.md) for sink retention and access requirements.

## Data lifecycle

Document purpose, retention, data locations, subprocessors, model-provider handling, user deletion, backup expiration, and support access before production. Disconnecting stops new work, attempts to revoke the grant, and removes the credential; data retention follows the disclosed policy. A separate data-deletion request stops sync, revokes/disables the connection, purges app and AI tables/checkpoints, invalidates caches and search results, and lets backup copies expire on the documented schedule. Tombstones prevent stale outbox events from repopulating deleted content.

## Security verification plan

- Current API tests cover missing/expired sessions, forged user and administrator fields, foreign session IDs, owner-scoped session revocation, and Prisma owner predicates. The PostgreSQL integration suite checks cross-owner connection, email, analysis, chunk, run, pending-action, task, and follow-up relationships.
- Add route-level same-owner/foreign-owner list, detail, update, and delete tests for each resource as those endpoints are implemented. Keep the owner ID in every database predicate; return the same `404` for nonexistent and foreign IDs.
- Unit tests for approval hash/version/expiry checks, token encryption wrapper, log redaction, and idempotency.
- Integration tests with two tenants for list/detail/search/agent/task/approval and duplicate provider IDs.
- Adversarial tests for prompt injection inside sender content, malformed MIME/HTML, oversized messages, stale approval, replayed callback, revoked OAuth, model timeout, and outbox replay.
- Dependency, secret, and static scans in CI; independent review of OAuth scope compliance and approval-to-send flow before live sending.

The Phase 13.3 audit and residual risks are recorded in [security-audit.md](security-audit.md). Measurable pre-deployment requirements and the test execution ledger are in [release-gates.md](release-gates.md).
