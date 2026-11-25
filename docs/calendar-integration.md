# Google Calendar integration

MailPilot keeps Google Calendar authorization separate from application sign-in and Gmail access. Calendar refresh tokens are encrypted in the API-owned PostgreSQL table and never go to the browser or FastAPI.

## Local Google Cloud setup

1. In Google Cloud Console, select the project used for MailPilot and enable **Google Calendar API**.
2. In Google Auth Platform, configure the consent screen and add `https://www.googleapis.com/auth/calendar.events.owned` under Data Access. Add the Google account you use for local development as a test user while the app is in Testing mode.
3. Under Clients, create a **Web application** OAuth client for Calendar. Add `http://localhost:4000/v1/oauth/google-calendar/callback` as an authorized redirect URI. The separate Calendar client keeps its consent configuration independent from the Gmail client.
4. Put the Calendar client ID and secret in the repository root `.env` as `GOOGLE_CALENDAR_OAUTH_CLIENT_ID` and `GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET`.
5. Generate a separate 32-byte token-encryption key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` and save it in `.env` as `GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY`.
6. Keep `GOOGLE_CALENDAR_EVENTS_ENABLED=false` while connecting and checking the approval flow. Restart the API, open **Settings → Connect Google Calendar**, and grant the requested permission.

Event creation is disabled until `GOOGLE_CALENDAR_EVENTS_ENABLED=true`. Enable it only in an environment where the authorized Calendar client, account, and approval flow have been verified. Restart the API after changing `.env`. The default remains `false`.

## Event proposal and creation

Email analysis displays editable event details before saving a proposal. The user must supply a start, end, and IANA time zone when extraction leaves any of them unclear. MailPilot resolves the local times server-side and rejects invalid zones, daylight-saving gaps, and repeated local times. The proposal snapshot stores both local wall times and resolved instants, the source message/thread/revision, evidence quote, owner, risk, creation time, and expiry.

The approval page previews the exact title, start/end, time zone, location, source evidence, and empty attendee list. Approval binds to the snapshot hash. Creating the event takes a second explicit action after approval; the API rechecks approval state, expiry, source revision, and authenticated owner before calling Google Calendar. Editing an event after saving a proposal requires a new proposal and approval.

The API targets the connected account's primary calendar and requests only `calendar.events.owned` (plus identity scopes for the OAuth flow). It reads the selected time window to detect overlapping events before insertion. A known overlap fails closed and the user must adjust and propose again. Google Calendar does not prevent other clients from adding an overlap between MailPilot's check and insert, so this check cannot guarantee conflict freedom against concurrent external edits.

MailPilot does not add attendees or send invitations. It requests `sendUpdates=none`. Event creation uses an event ID derived from the durable execution key and private MailPilot markers. A retry of the same approved proposal therefore finds and verifies the existing event instead of inserting a duplicate. If the API outcome is uncertain, the proposal enters reconciliation; it cannot be retried until Google confirms the prior event was not created. An expired or revoked grant is marked for reconnection. Calendar access errors never fall back to an unapproved operation.

Only event creation is supported. Editing or cancelling Calendar events is not exposed. Disconnecting Calendar revokes the stored token best-effort and clears MailPilot's encrypted credential; it does not delete existing Google events.

## Verification

Automated tests cover approved-only execution, duplicate submissions, stable event IDs, overlap conflicts, unauthorized ownership, disabled writes, expired grants, ambiguous/nonexistent local times, and reconciliation after uncertain provider outcomes. Provider requests are mocked in tests.
