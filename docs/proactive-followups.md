
## Proactive follow-up suggestions

`FollowUpSettings` is one-to-one with a user and disabled by default. It controls commitment lead hours, stale-thread age in days, IANA timezone, optional local quiet hours, daily suggestion limit, and feature toggles. `FollowUp` stores a source email/thread, kind, optional commitment, deduplication key, schedule, reason, and lifecycle status. A unique `(userId,deduplicationKey)` prevents duplicate work. Old follow-ups are backfilled with their email's thread ID and a one-off legacy key.

The API and scanner always include `userId` in database operations. Stale detection selects only the latest message per owner-scoped Google thread; it offers a suggestion only when that message is inbound and old enough. Active commitments qualify at `dueAt - leadHours`. A new inbound or outbound message changes/cancels stale evidence; changed or fulfilled commitments cancel the old suggestion. Dismissed items do not reactivate. Snoozing changes only the in-app suggestion time. Quiet hours and daily caps are calculated in the configured timezone, including daylight-saving transitions.

The worker queues one scan per enabled user per 15-minute window using a stable job ID. BullMQ retries transient failures with capped exponential backoff; the scan itself makes one short bounded retry. Scans are read-only with respect to Gmail, Calendar, and external services. Suggestions never send a message, create a calendar event, or bypass the existing approval lifecycle.
