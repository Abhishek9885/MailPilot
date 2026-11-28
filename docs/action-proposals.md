# Action Proposals

MailPilot persists proposals in `app.pending_actions`. `POST /v1/actions/proposals` creates a pending snapshot and `GET /v1/actions/proposals` lists snapshots for the authenticated user. Owner-authenticated approve and reject decisions are available. Calendar event creation is the only provider-backed action; it is disabled by default and requires a separate user approval followed by an explicit execution request. Gmail send, task creation, and follow-up scheduling still use local mocks.

## Supported proposal types

| Action type | Exact payload | Risk |
| --- | --- | --- |
| `send_email` | `to`, `cc`, `bcc`, `subject`, `bodyText`, and nullable `replyToEmailId` | high |
| `create_task` | `title`, nullable `description`, nullable `dueAt`, and nullable `sourceEmailId` | low |
| `schedule_follow_up` | `emailId` and `scheduledAt` | medium |
| `create_calendar_event` | `title`, `startAt`, `endAt`, `startLocal`, `endLocal`, IANA `timezone`, nullable `location`, and source `sourceEmailId` | medium |

Email proposals require at least one valid recipient, reject duplicate addresses across recipient fields and header control characters, and require nonblank subject and body text. Proposed payloads are preserved as validated; no mail is sent.

## Snapshot and authorization

The client supplies an idempotency key, action type and payload, and evidence references. Workflow proposals also require an agent-run ID; a Calendar event proposal may omit it because it is created from the user-reviewed event form. Express supplies the user ID, risk level, creation time, and 24-hour expiry. Each evidence reference identifies an email row, provider thread, source revision, and exact quote. The API verifies any supplied run is completed and belongs to the signed-in user, and that each undeleted source email belongs to that user, has the referenced revision and thread, and contains the quote.

The immutable JSON snapshot contains the schema version, owner, optional run, idempotency key, exact action payload, source evidence, risk, creation time, and expiry. A SHA-256 hash covers the canonicalized snapshot. The database trigger rejects updates to snapshot, owner, identity, hash, and expiry columns; lifecycle transitions may update only decision state. Listing and idempotency lookups are user-scoped. Reusing an idempotency key with the same proposal returns the existing record; using it for a different proposal is rejected.

Risk levels are server-derived from the allowlisted action type. Callers cannot set user identity, risk, creation time, expiry, or status. Email evidence and action payloads are not logged.

## Approval lifecycle

The allowed transitions are:

```text
pending -> approved | rejected | expired
approved -> executing | expired
executing -> succeeded | failed | reconciliation_required
reconciliation_required -> succeeded | failed | approved | expired
```

`POST /v1/actions/proposals/:id/approve` and `/reject` require a signed-in owner, CSRF validation, and `{ "payloadHash": "<sha256>" }`. The API compares that hash with the immutable stored snapshot and atomically transitions only a still-pending, unexpired row owned by that user. A stale hash, duplicate decision, expired proposal, or another user's ID is rejected. Listing and decisions persist due expirations as `expired`.

The approvals page reads persisted proposals and presents the exact payload, destination or recipients, source quote and revision, risk, and expiry before a decision. Approval and rejection post the displayed snapshot hash. `POST /v1/actions/proposals/:id/execute` is also owner- and CSRF-protected and requires the displayed hash. Before execution, the service reloads the row under the authenticated owner, compares the approved hash, checks expiry and source revision/thread/quote again, and atomically claims the `executing` state. A deterministic SHA-256 execution key is stored on the first claim and reused for every safe retry. A unique database index and compare-and-set claim prevent concurrent or replayed requests from invoking execution twice.

The executor contract takes that stable key as the provider idempotency key. It must report `failed` only when it can confirm no external effect occurred. Exceptions, timeouts, partial outcomes, and uncertain results transition to `reconciliation_required`; they never trigger an automatic retry. The owner can call `POST /v1/actions/proposals/:id/reconcile` to check the result. A durable reconciliation lease allows only one live outcome check, and stale checks cannot overwrite a newer result. A confirmed success or failure is recorded as terminal. A retry returns to `approved` only when reconciliation confirms no action occurred and the original approval has not expired. The same immutable payload and execution key are retained. Unknown outcomes stay blocked. Expired execution leases become `reconciliation_required` for later checking.

The default configuration has `GOOGLE_CALENDAR_EVENTS_ENABLED=false`. When enabled, only `create_calendar_event` reaches Google Calendar, and only after the approved payload has been revalidated and the owner has an active separate Calendar connection with the required scope. The adapter targets the primary calendar, adds no attendees, sets `sendUpdates=none`, and checks the requested interval for conflicts before insertion. It derives a stable Calendar event ID from the durable execution key and verifies private MailPilot execution, payload-hash, and source-message markers when reconciling. Uncertain outcomes remain blocked until reconciliation confirms whether the event exists. Event updates and cancellations are not supported. All other proposal types use a local mock and make no provider write.

Creation, user decisions, mock/provider execution claims and results, reconciliation, and expiry transitions are written to `app.audit_logs` in the same transaction as their proposal row changes. Audit metadata includes event type, status transition, action type, execution attempt count, safe result code, request ID when available, and payload hash; email content, idempotency keys, and tokens are excluded. Editing a proposed payload is unsupported; changed content must be submitted as a new proposal and approved by its new snapshot hash.
