# MailPilot AI API contracts

**Status:** target HTTP/JSON contracts. Express implements liveness/readiness, Google OIDC application sign-in, Gmail OAuth, parsed email storage, bounded Gmail sync, owner-scoped email listing and analysis, and suggestion-only reply drafting. Agent and approval endpoints below remain planned. Publish an OpenAPI document for each HTTP boundary and maintain cross-language JSON fixtures.

## Contract rules

- Public base path: `/v1`. Internal FastAPI and Express paths: `/internal/v1`; they are reachable only over private networking and authenticated service identity.
- JSON uses camelCase, UTF-8, ISO 8601 UTC timestamps, opaque IDs, and explicit `null` when a known field has no value. Message IDs and history IDs remain strings.
- Every request has or receives `requestId`; every agent workflow has `runId`; state-changing public requests accept `Idempotency-Key`.
- Lists use opaque cursors, a bounded `limit`, and stable ordering. Clients never submit database user IDs as authority; Express derives user identity from the session.
- Errors use `{ "error": { "code": "...", "message": "...", "requestId": "...", "retryable": false, "details": {} } }`. Do not echo provider response bodies, email bodies, or secrets.
- Public endpoints use the MailPilot session. Internal analysis and reply-drafting calls use a time-bound HMAC signature over the HTTP method, route, request ID, timestamp, and exact request body. The signing secret stays in API and AI service environments; signatures expire after 60 seconds. Execute-action also requires the signed approval grant described below.

## Browser → Express public API

Next.js calls Express for all data and mutations. Deploy the web and API on the same host so the host-only session cookie reaches both. For cookie-authenticated writes, require the CSRF cookie/header pair and validate Origin. App sign-in uses a separate Google OIDC client requesting only `openid email`; it does not grant Gmail access. Gmail OAuth client configuration and scopes remain separate. OAuth tokens never appear in responses.

The production session cookie is `__Host-mailpilot_session; Path=/; Secure; HttpOnly; SameSite=Lax`, with an eight-hour absolute expiry and no `Domain` attribute. Development uses `mailpilot_session` without `Secure` on localhost. `__Host-mailpilot_csrf` is readable by the web client, `Secure`, `SameSite=Strict`, and stored in the session row as a hash. Sign-out and future cookie-authenticated writes require the matching `x-csrf-token` header and the configured web Origin.

Every current `/v1` route other than the explicit Google OIDC start/callback flow requires a validated application session; the session lookup and sign-out handlers also require that session. `userId` comes from that session, never from a request field or header. The email-analysis route scopes email reads and analysis writes by both record ID and `authContext.userId`. Database foreign keys enforce same-owner relationships between records but do not authorize reads. `AuditActorType.administrator` is an audit label, not an application role.

| Method and path | Purpose | Important contract |
|---|---|---|
| `GET /v1/auth/google/start?returnTo=` | Start application sign-in | Express redirects to Google using `openid email`, random state/nonce, and S256 PKCE. `returnTo` is limited to known web routes. |
| `GET /v1/auth/google/callback` | Complete application sign-in | Validates the one-time browser-bound transaction and ID token, creates a database session, sets session/CSRF cookies, and redirects to the allowlisted page. |
| `GET /v1/auth/session` | Check the current application session | Returns `{ "user": { "id": "...", "email": "..." } }`; rejects expired, revoked, or disabled-user sessions. Response is `no-store`. |
| `POST /v1/auth/sign-out` | Revoke the current application session | Requires the session cookie, CSRF header/cookie pair, and configured web Origin. Revokes the database session and clears both cookies. Returns `204`. |
| `GET /v1/me` | Current identity and feature state | Returns public user ID and connection status; no token material. |
| `GET /v1/gmail/connect` | Start Gmail authorization | Express redirects to Google or returns `{authorizationUrl}`. `state` is server-generated, one-time, session-bound. |
| `GET /v1/oauth/google/callback` | OAuth callback | Browser redirect endpoint only; validates state and code, exchanges server-side, redirects to an allowlisted UI path. Never log query parameters. |
| `GET /v1/gmail/connection` | Connection and scope status | Returns granted scope names, connection state, last sync time, and `reauthRequired`; no tokens. |
| `DELETE /v1/gmail/connection` | Disconnect Gmail | Requests cancellation of active sync work, attempts to revoke consent, and removes credentials. MailPilot-held data is retained until deleted separately. |
| `DELETE /v1/gmail/data` | Delete MailPilot’s copy of Gmail data | Stops sync first and asynchronously deletes mailbox, AI index, extraction, run, and checkpoint data; returns a deletion job/status. It does not delete mail from Gmail. |
| `POST /v1/syncs` | Start a bounded sync | Body: `{ "mode": "initial", "maxMessages": 500 }` or `{ "mode": "incremental" }`; requires CSRF protection and returns `202 {sync}`. Initial cap is 500 by default and can be set from 1 to 2,000. |
| `POST /v1/syncs/{syncId}/step` | Process one bounded sync batch | Requires CSRF protection. Each call processes at most 25 messages and returns the updated progress. Call again while status is `pending` or `partial`; clients may poll between calls. |
| `GET /v1/syncs/{syncId}` | Poll sync | Owner-scoped progress counts, status, completion time, cap state, and safe error code. Gmail cursors, page tokens, and credentials are never returned. |
| `DELETE /v1/syncs/{syncId}` | Cancel sync | Requires CSRF protection. A running batch finishes its current message before stopping; unprocessed checkpoints remain available for diagnosis. |
| `GET /v1/emails?limit=20` | List recently synced emails | Returns up to 50 owner-scoped email summaries with no body content. |
| `GET /v1/emails/{emailId}/analysis` | Read the current saved analysis | Returns `{ "analysis": null }` when the current email revision has not been analyzed. |
| `POST /v1/emails/{emailId}/analysis` | Analyze or re-analyze a stored email | Requires session and CSRF protection. Optional body `{ "reanalyze": true }` bypasses the same-revision cache. Express loads email content using the session owner; clients cannot provide prompt text. |
| `GET /v1/emails/{emailId}/reply-drafts` | List saved reply suggestions | Returns up to 50 most recent suggestion records for the owner-scoped email. |
| `POST /v1/emails/{emailId}/reply-drafts` | Generate an editable reply suggestion | Requires session and CSRF protection. Express loads the selected email plus up to seven recent messages from the same owner and Gmail thread. Optional body: `{ "instruction": "Keep it brief" }`; email content is loaded from storage. Returns a stored suggestion or an explicit missing-context result. |
| `PATCH /v1/emails/{emailId}/reply-drafts/{draftId}` | Edit a reply suggestion | Requires session and CSRF protection. Body accepts `bodyText` and optional `subject`. The record remains a suggestion and is never sent. |
| `GET /v1/threads?cursor=&limit=&from=&to=&label=` | Browse synchronized mail | Account scope comes from session; body content is not included in list responses. |
| `GET /v1/threads/{threadId}` | Read thread | Returns sanitized text, message headers allowlisted for UI, and synchronization/index status. |
| `POST /v1/agent/runs` | Understand a thread, retrieve context, or draft | Requires `Idempotency-Key`; body below. Returns `202` with `runId`, state, and polling URL. |
| `GET /v1/agent/runs/{runId}` | Read run result | Owner-scoped. Returns status, answer, source references, extraction/task candidates, draft, or pending approval. |
| `GET /v1/approvals?status=pending` | List pending approvals | Returns exact proposed action snapshot, expiry, version, and associated source thread. |
| `POST /v1/approvals/{approvalId}/decision` | Approve, reject, or edit then approve | Requires idempotency key and `If-Match` approval version. Approval means only the displayed canonical action. |
| `GET /v1/tasks?status=&dueBefore=` | Browse extracted task candidates | Account and user filters are server enforced. |

### Email analysis response

`POST /v1/emails/{emailId}/analysis` returns `{ "analysis": { ... } }` with the stored row ID, source revision, schema version, provider/model version, usage metadata, and validated analysis. The analysis contains one or more categories (`work`, `personal`, `finance`, `travel`, `shopping`, `social`, `newsletter`, `security`, or `other`), a priority (`low`, `normal`, `high`, or `urgent`), a concise summary, action items, deadline candidates, commitments, and event candidates. Calendar dates use ISO `YYYY-MM-DD`; unresolved dates and times are `null`. Evidence is a short quote that must occur in the stored email text or headers. The analysis is cached by owner, email, source revision, and schema version.

The Express route reads the email from PostgreSQL and does not accept body text from the caller. Requests require session authentication and CSRF validation. The internal FastAPI call uses a 60-second method/path/request-ID/body-bound HMAC signature; its shared secret is never returned to the browser. A changed email revision during analysis returns `409 EMAIL_CHANGED_DURING_ANALYSIS`; provider failures or invalid output return a safe retryable `502 AI_ANALYSIS_FAILED` without persisting generated text.

`GET /v1/emails/{emailId}/analysis` reads a result only for the authenticated owner and current email revision. `POST` without `reanalyze` reuses a completed result; setting `reanalyze` to `true` explicitly runs the model again. Both operations use server-loaded email content and never accept browser-supplied message text.

### Reply draft suggestions

`POST /v1/emails/{emailId}/reply-drafts` returns `{ "suggestion": ... }` after validating and storing an editable suggestion in `app.reply_drafts`. Express loads at most eight messages (the selected message plus up to seven recent messages from its thread), each bounded to 30,000 characters and 50,000 characters total. The FastAPI serialized request has a separate 60,000-character ceiling. A model response that cannot draft safely returns `{ "suggestion": null, "missingContextReason": ..., "uncertainties": [...] }` and is not stored. Suggestions carry the source message IDs/revisions, evidence quotes for factual claims, uncertainty labels, provider/model metadata, and an `edited` marker.

FastAPI treats every email field as untrusted data and does not follow instructions embedded in email content. It has no tools and cannot send mail or create attachments. Both FastAPI and Express validate source references and evidence quotes against the supplied thread; unsupported claims reject the response. `PATCH` edits are owner-scoped, remain `suggestion` records, and add an uncertainty label that evidence links may not cover manual additions. No Gmail send endpoint or write scope is part of this feature. If any source message changes while generation runs, Express returns `409 REPLY_DRAFT_SOURCE_CHANGED` and stores nothing.

### Gmail sync behavior and resynchronization

Initial sync reads the mailbox profile first and saves that `historyId` as its snapshot cursor. It then lists messages newest-first in pages up to the requested message cap. Once all listed messages are stored, the connection cursor is set to the saved snapshot cursor. Later incremental syncs replay mailbox changes from that point, including changes made while the initial listing was running. Each page and pending message ID is checkpointed in PostgreSQL; message writes are idempotent by Gmail connection and message ID. A cursor is advanced only after all message IDs from every history page have been handled. Transient failures leave the current page/checkpoint and old cursor available for retry. Permanent message parse/provider failures are counted and fail the run without advancing the cursor.

Incremental sync uses Gmail `history.list` for added, deleted, and label-changed messages. If a message disappears before its full message fetch, MailPilot records a local tombstone. Label changes are reflected by fetching and upserting the current Gmail message. Gmail can expire old history IDs; a 404 during history retrieval produces `resync_required` and leaves the saved cursor unchanged. To recover, start a new bounded initial sync, choosing a larger `maxMessages` if older mail should be included. Upserts deduplicate existing messages and preserve prior data outside the scanned range. Repeat incremental sync after the initial sync completes to apply changes that happened during the bounded scan.

The Gmail consent scope remains `gmail.readonly`; sync does not create, send, modify, or delete Gmail messages. These endpoints run work in bounded request-driven batches and do not require Gmail push, Redis, or a background worker.

### Create agent run

```json
{
  "accountId": "acc_opaque",
  "threadId": "gmail-thread-id",
  "intent": "draft_reply",
  "instruction": "Confirm Thursday at 2 pm and ask whether a video link will be sent."
}
```

`accountId` is checked against the session and is a selector, never authorization. Supported MVP intents are `understand_thread`, `find_context`, and `draft_reply`. An `INDEX_NOT_READY` result is `409` and includes a safe retry hint; do not run with incomplete history silently. A response is not considered a verified fact unless it includes source references or explicitly states that evidence is missing.

### Run response

```json
{
  "runId": "run_opaque",
  "status": "approval_required",
  "answer": null,
  "sources": [
    {"messageId": "gmail-message-id", "threadId": "gmail-thread-id", "sentAt": "2026-10-08T09:00:00Z", "chunkId": "chk_opaque", "quote": "Thursday at 2 pm works."}
  ],
  "draft": {
    "to": ["person@example.com"], "cc": [], "subject": "Re: Planning", "bodyText": "...",
    "replyToMessageId": "gmail-message-id", "threadId": "gmail-thread-id", "version": 3
  },
  "approval": {"approvalId": "apr_opaque", "status": "pending", "version": 1, "expiresAt": "2026-10-10T09:00:00Z"}
}
```

The source quote is a bounded excerpt of the user’s own mailbox. It is rendered as inert text. Structured extraction fields carry `value`, `confidence`, and `evidence[]` references; dates include timezone or an explicit unresolved timezone status.

### Decide approval

```json
{
  "decision": "approve",
  "approvedActionVersion": 1,
  "editedDraft": null
}
```

For edits, send the full edited draft snapshot and the current version; the server recalculates its canonical hash. The user must approve the resulting version explicitly. The server performs a compare-and-set from `pending` to `approved`, commits the approval and audit event, then resumes the graph. Duplicate decision submissions return the original result. A different decision against an already decided approval returns `409 APPROVAL_ALREADY_DECIDED`.

## Express → FastAPI private API

FastAPI uses a separate internal OpenAPI document and verifies each signed service request before model processing. Normalized email content crosses this boundary only for configured analysis and suggestion-only reply workflows. The payload contains no OAuth credentials.

| Method and path | Purpose |
|---|---|
| `POST /internal/v1/email-analysis/` | Analyze one owner-scoped email revision. Express supplies its user/email IDs, source revision, sender metadata, received time, subject, and bounded plain-text body. FastAPI returns validated analysis and provider/model metadata; Express persists the result through Prisma. |
| `POST /internal/v1/reply-drafts/` | Generate a bounded thread reply suggestion. Express supplies owner-scoped message IDs/revisions, sender metadata, timestamps, subjects, plain-text bodies, and an optional user-authored style instruction. FastAPI returns a schema-validated suggestion, source references, uncertainty labels, and provider/model metadata; Express validates and persists it through Prisma. |
| `POST /internal/v1/email-events` | Upsert one or more normalized email revisions into the AI index. Idempotency key is `(accountId,messageId,sourceRevision)`. Return per-message `accepted`, `alreadyCurrent`, or `retryableFailure`. |
| `POST /internal/v1/runs` | Create a graph run. Input includes MailPilot `userId`, account/thread/message IDs, intent, instruction, and verified connection/index state. FastAPI validates identifiers and limits. |
| `GET /internal/v1/runs/{runId}` | Return internal state projection for Express orchestration; never returns secrets or raw checkpoints. |
| `POST /internal/v1/runs/{runId}/resume` | Resume a checkpoint with a decision already committed by Express. The body contains approval ID, action version/hash, decision, and a signed short-lived grant. |
| `POST /internal/v1/index-deletions` | Tombstone/delete account or message IDs from AI retrieval and checkpoint-associated sensitive state. Idempotent. |
| `GET /internal/v1/health/live` and `/ready` | Liveness/readiness; readiness may verify database/model adapter configuration without exposing credentials. |

Email event shape:

```json
{
  "eventId": "evt_opaque",
  "accountId": "acc_opaque",
  "sourceRevision": "gmail-history-id-or-local-revision",
  "operation": "upsert",
  "message": {
    "messageId": "gmail-message-id", "threadId": "gmail-thread-id",
    "sentAt": "2026-10-08T09:00:00Z", "from": [{"email":"person@example.com","name":"Person"}],
    "to": [{"email":"owner@example.com","name":null}], "subject":"Planning",
    "labels":["INBOX"], "bodyText":"normalized plain text"
  }
}
```

Deletion events contain identifiers and operation only. Repeated events at the same or older source revision do not restore stale content.

## Approved action gateway

FastAPI is not a Gmail client. When an approved graph resumes, a send tool calls Express at `POST /internal/v1/actions/{actionId}/execute` with:

```json
{
  "runId": "run_opaque", "approvalId": "apr_opaque", "approvalVersion": 2,
  "payloadHash": "sha256:...", "idempotencyKey": "run_opaque:action_opaque:v2",
  "action": {"type":"send_reply","accountId":"acc_opaque","threadId":"gmail-thread-id","replyToMessageId":"gmail-message-id","to":["person@example.com"],"cc":[],"subject":"Re: Planning","bodyText":"..."}
}
```

Express re-reads and verifies the approved record, owner/account relationship, exact payload hash, send scope, expiration, and action status. It constructs a Gmail reply with the target `threadId` and RFC-compliant `In-Reply-To` and `References` headers and a matching subject, as required by [Gmail thread guidance](https://developers.google.com/workspace/gmail/api/guides/threads). It persists an `executing` record before the Gmail request and reconciles ambiguous outcomes before any retry. A duplicate request returns the recorded result. The internal grant is short-lived and scoped to one approval/action; it does not authorize arbitrary Gmail API operations.

## Error codes

Use stable codes: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `INVALID_ARGUMENT`, `RATE_LIMITED`, `CONFLICT`, `INDEX_NOT_READY`, `REAUTH_REQUIRED`, `SCOPE_REQUIRED`, `APPROVAL_EXPIRED`, `APPROVAL_ALREADY_DECIDED`, `PROVIDER_UNAVAILABLE`, and `INTERNAL`. Only transient failures set `retryable: true`. Do not expose whether another user owns an ID.

## Contract validation

The implementation should validate public and private payloads at both boundaries with generated OpenAPI/JSON Schema or equivalent runtime validators. CI runs TypeScript contract tests plus Python Pydantic/OpenAPI tests against shared fixtures. Never make a breaking contract change without updating fixtures and both clients in the same change.
