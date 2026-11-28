import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ActionProposalSnapshotSchema, ActionProposalSchemaVersion, GoogleCalendarScope } from "@mailpilot/shared";
import { CalendarActionRuntime } from "../src/calendar/action-executor.js";
import { eventIdForKey, GoogleCalendarApi } from "../src/calendar/calendar-api.js";
import { GoogleCalendarReauthRequiredError, type GoogleCalendarOAuthClient } from "../src/calendar/google-oauth.js";
import type { GoogleCalendarConnectionRecord, GoogleCalendarConnectionStore } from "../src/calendar/types.js";

const userId = "49362a23-117c-4a53-9651-12090cf07327";
const emailId = "f1d6b4df-eacf-4a18-a6e5-b036feac3388";
const key = "a".repeat(64);

function createSnapshot() {
  const now = new Date("2026-11-20T10:00:00.000Z");
  return ActionProposalSnapshotSchema.parse({
    schemaVersion: ActionProposalSchemaVersion,
    userId,
    agentRunId: null,
    idempotencyKey: "6f7c7df9-11b8-45e1-8cf0-17acb7621618",
    actionType: "create_calendar_event",
    payload: {
      title: "Project review",
      startAt: "2027-02-01T04:30:00.000Z",
      endAt: "2027-02-01T05:30:00.000Z",
      startLocal: "2027-02-01T10:00",
      endLocal: "2027-02-01T11:00",
      timezone: "Asia/Kolkata",
      location: "Room 4",
      sourceEmailId: emailId
    },
    sourceEvidence: [{ emailId, threadId: "thread-42", sourceRevision: 3, quote: "Let's meet on February 1." }],
    riskLevel: "medium",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString()
  });
}

function createStore(overrides: Partial<GoogleCalendarConnectionRecord> = {}) {
  const connection: GoogleCalendarConnectionRecord = {
    id: randomUUID(), userId, providerSubject: "google-subject", email: "owner@example.test",
    status: "active", grantedScopes: ["openid", "email", GoogleCalendarScope],
    connectedAt: new Date("2026-11-01T00:00:00.000Z"), disconnectedAt: null,
    ...overrides
  };
  const store: GoogleCalendarConnectionStore = {
    connectCalendar: vi.fn(async () => connection),
    getConnection: vi.fn(async (requestedUserId) => requestedUserId === userId ? connection : null),
    getDecryptedRefreshToken: vi.fn(async (requestedUserId) => requestedUserId === userId ? "encrypted-token-decrypted" : null),
    markReauthRequired: vi.fn(async () => undefined),
    disconnectCalendar: vi.fn(async () => undefined)
  };
  return { connection, store };
}

function createOAuth(overrides: Partial<GoogleCalendarOAuthClient> = {}): GoogleCalendarOAuthClient {
  return {
    buildAuthorizationUrl: vi.fn(async () => new URL("https://accounts.google.com")),
    exchangeAuthorizationCode: vi.fn(async () => ({
      subject: "google-subject", email: "owner@example.test", emailVerified: true,
      refreshToken: "refresh-token", grantedScopes: [GoogleCalendarScope]
    })),
    refreshAccessToken: vi.fn(async () => ({ accessToken: "access-token", expiresInSeconds: 3600 })),
    revokeToken: vi.fn(async () => undefined),
    ...overrides
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("approved Calendar event execution", () => {
  it("uses a stable Google event ID so repeated provider submissions reconcile to one event", async () => {
    const events = new Map<string, Record<string, unknown>>();
    const submittedIds: string[] = [];
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST") {
        const incoming = JSON.parse(String(init.body)) as Record<string, unknown>;
        const id = String(incoming.id);
        submittedIds.push(id);
        const existing = events.get(id);
        if (existing) return response({ error: { code: 409 } }, 409);
        const created = { ...incoming, status: "confirmed" };
        events.set(id, created);
        return response(created);
      }
      if (url.searchParams.has("timeMin")) return response({ items: [] });
      const event = events.get(url.pathname.split("/").at(-1) ?? "");
      return event ? response(event) : response({}, 404);
    });
    const { store } = createStore();
    const api = new GoogleCalendarApi(fetcher);
    const runtime = new CalendarActionRuntime({ enabled: true, connectionStore: store, oauthClient: createOAuth(), calendarApi: api });
    const snapshot = createSnapshot();
    const context = { userId, idempotencyKey: key, signal: new AbortController().signal };

    const first = await runtime.execute(snapshot, context);
    const duplicate = await runtime.execute(snapshot, context);

    expect(first.status).toBe("succeeded");
    expect(duplicate.status).toBe("succeeded");
    expect(submittedIds).toEqual([eventIdForKey(key)]);
    expect(events.size).toBe(1);
    expect(events.get(eventIdForKey(key))).toMatchObject({ summary: "Project review", status: "confirmed" });
  });

  it("leaves transient provider outcomes uncertain and reconciles before any retry", async () => {
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      if (init?.method === "POST") return response({}, 503);
      if (new URL(String(input)).searchParams.has("timeMin")) return response({ items: [] });
      return response({}, 404);
    });
    const { store } = createStore();
    const runtime = new CalendarActionRuntime({
      enabled: true, connectionStore: store, oauthClient: createOAuth(), calendarApi: new GoogleCalendarApi(fetcher)
    });
    const snapshot = createSnapshot();
    const context = { userId, idempotencyKey: key, signal: new AbortController().signal };

    const result = await runtime.execute(snapshot, context);
    const reconciliation = await runtime.reconcile(snapshot, context);

    expect(result.status).toBe("uncertain");
    expect(reconciliation).toBe("not_executed");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("blocks creation when the requested interval overlaps an existing event", async () => {
    const fetcher: typeof fetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.has("timeMin")) {
        return response({ items: [{
          id: "existing-event", status: "confirmed",
          start: { dateTime: "2027-02-01T04:45:00.000Z" },
          end: { dateTime: "2027-02-01T05:00:00.000Z" }
        }] });
      }
      return response({}, 404);
    });
    const { store } = createStore();
    const runtime = new CalendarActionRuntime({
      enabled: true, connectionStore: store, oauthClient: createOAuth(), calendarApi: new GoogleCalendarApi(fetcher)
    });

    const result = await runtime.execute(createSnapshot(), {
      userId, idempotencyKey: key, signal: new AbortController().signal
    });

    expect(result).toMatchObject({ status: "failed", resultCode: "CALENDAR_EVENT_CONFLICT" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("treats a same-day all-day event as a Calendar conflict", async () => {
    const fetcher: typeof fetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.has("timeMin")) {
        return response({ items: [{
          id: "all-day-event", status: "confirmed", start: { date: "2027-02-01" }, end: { date: "2027-02-02" }
        }] });
      }
      return response({}, 404);
    });
    const { store } = createStore();
    const runtime = new CalendarActionRuntime({
      enabled: true, connectionStore: store, oauthClient: createOAuth(), calendarApi: new GoogleCalendarApi(fetcher)
    });

    const result = await runtime.execute(createSnapshot(), {
      userId, idempotencyKey: key, signal: new AbortController().signal
    });

    expect(result).toMatchObject({ status: "failed", resultCode: "CALENDAR_EVENT_CONFLICT" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not call Calendar for a different owner", async () => {
    const { store } = createStore();
    const createEvent = vi.fn(async () => undefined);
    const runtime = new CalendarActionRuntime({
      enabled: true,
      connectionStore: store,
      oauthClient: createOAuth(),
      calendarApi: { createEvent, reconcileEvent: vi.fn(async () => "unknown" as const) }
    });

    const result = await runtime.execute(createSnapshot(), {
      userId: randomUUID(), idempotencyKey: key, signal: new AbortController().signal
    });

    expect(result.status).toBe("failed");
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("rejects a proposal whose owner does not match the authenticated execution owner", async () => {
    const { store } = createStore();
    const createEvent = vi.fn(async () => undefined);
    const runtime = new CalendarActionRuntime({
      enabled: true,
      connectionStore: store,
      oauthClient: createOAuth(),
      calendarApi: { createEvent, reconcileEvent: vi.fn(async () => "unknown" as const) }
    });
    const foreignSnapshot = { ...createSnapshot(), userId: randomUUID() };

    const result = await runtime.execute(foreignSnapshot, {
      userId, idempotencyKey: key, signal: new AbortController().signal
    });

    expect(result).toMatchObject({ status: "failed", resultCode: "ACTION_OWNER_MISMATCH" });
    expect(store.getConnection).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("marks an expired grant for reauthorization and stops before event creation", async () => {
    const { store } = createStore();
    const createEvent = vi.fn(async () => undefined);
    const oauth = createOAuth({
      async refreshAccessToken() { throw new GoogleCalendarReauthRequiredError(); }
    });
    const runtime = new CalendarActionRuntime({
      enabled: true,
      connectionStore: store,
      oauthClient: oauth,
      calendarApi: { createEvent, reconcileEvent: vi.fn(async () => "unknown" as const) }
    });

    const result = await runtime.execute(createSnapshot(), { userId, idempotencyKey: key, signal: new AbortController().signal });

    expect(result.status).toBe("failed");
    expect(store.markReauthRequired).toHaveBeenCalledWith(userId);
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("keeps live event writes disabled by default", async () => {
    const { store } = createStore();
    const createEvent = vi.fn(async () => undefined);
    const oauth = createOAuth();
    const runtime = new CalendarActionRuntime({
      enabled: false,
      connectionStore: store,
      oauthClient: oauth,
      calendarApi: { createEvent, reconcileEvent: vi.fn(async () => "unknown" as const) }
    });

    const result = await runtime.execute(createSnapshot(), { userId, idempotencyKey: key, signal: new AbortController().signal });

    expect(result.status).toBe("failed");
    expect(oauth.refreshAccessToken).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
  });
});
