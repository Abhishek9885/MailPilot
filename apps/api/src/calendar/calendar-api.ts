import { createHash } from "node:crypto";
import type { CreateCalendarEventActionPayload } from "@mailpilot/shared";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export interface CalendarEventSnapshot {
  actionType: "create_calendar_event";
  payload: CreateCalendarEventActionPayload;
  sourceEvidence: Array<{ emailId: string; quote: string }>;
  payloadHash: string;
}

export interface CalendarEventApi {
  createEvent(accessToken: string, snapshot: CalendarEventSnapshot, idempotencyKey: string, signal: AbortSignal): Promise<void>;
  reconcileEvent(accessToken: string, snapshot: CalendarEventSnapshot, idempotencyKey: string, signal: AbortSignal): Promise<"succeeded" | "not_executed" | "unknown">;
}

export type CalendarApiErrorKind = "unauthorized" | "conflict" | "transient" | "permanent";

export class CalendarApiError extends Error {
  public constructor(public readonly kind: CalendarApiErrorKind) {
    super("Google Calendar request failed.");
    this.name = "CalendarApiError";
  }
}

export class GoogleCalendarApi implements CalendarEventApi {
  public constructor(private readonly fetcher: typeof fetch = fetch) {}

  public async createEvent(
    accessToken: string,
    snapshot: CalendarEventSnapshot,
    idempotencyKey: string,
    signal: AbortSignal
  ): Promise<void> {
    const previous = await this.reconcileEvent(accessToken, snapshot, idempotencyKey, signal);
    if (previous === "succeeded") return;
    if (previous === "unknown") throw new CalendarApiError("conflict");
    await this.ensureNoScheduleConflict(accessToken, snapshot, idempotencyKey, signal);
    const response = await this.fetcher(`${CALENDAR_API_BASE}?sendUpdates=none`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(buildCalendarEvent(snapshot, idempotencyKey)),
      signal
    });
    if (response.ok) {
      const body: unknown = await response.json();
      if (isMatchingEvent(body, snapshot, idempotencyKey)) return;
      throw new CalendarApiError("transient");
    }
    throw providerError(response.status);
  }

  private async ensureNoScheduleConflict(
    accessToken: string,
    snapshot: CalendarEventSnapshot,
    idempotencyKey: string,
    signal: AbortSignal
  ): Promise<void> {
    const base = new URL(CALENDAR_API_BASE);
    base.searchParams.set("timeMin", snapshot.payload.startAt);
    base.searchParams.set("timeMax", snapshot.payload.endAt);
    base.searchParams.set("singleEvents", "true");
    base.searchParams.set("orderBy", "startTime");
    base.searchParams.set("maxResults", "2500");
    base.searchParams.set("timeZone", snapshot.payload.timezone);
    base.searchParams.set("fields", "items(id,status,start,end),nextPageToken");

    let pageToken: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      if (pageToken) base.searchParams.set("pageToken", pageToken);
      else base.searchParams.delete("pageToken");
      const response = await this.fetcher(base.toString(), {
        headers: { authorization: `Bearer ${accessToken}` },
        signal
      });
      if (!response.ok) throw providerError(response.status);
      const body: unknown = await response.json();
      const pageResult = parseEventList(body);
      if (!pageResult) throw new CalendarApiError("permanent");
      for (const event of pageResult.items) {
        if (event.id === eventIdForKey(idempotencyKey)) continue;
        if (event.status === "cancelled") continue;
        if (eventOverlaps(event, snapshot)) throw new CalendarApiError("conflict");
      }
      pageToken = pageResult.nextPageToken;
      if (!pageToken) return;
    }
    if (pageToken) throw new CalendarApiError("permanent");
  }

  public async reconcileEvent(
    accessToken: string,
    snapshot: CalendarEventSnapshot,
    idempotencyKey: string,
    signal: AbortSignal
  ): Promise<"succeeded" | "not_executed" | "unknown"> {
    const eventId = eventIdForKey(idempotencyKey);
    const response = await this.fetcher(`${CALENDAR_API_BASE}/${encodeURIComponent(eventId)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal
    });
    if (response.status === 404) return "not_executed";
    if (!response.ok) throw providerError(response.status);
    const body: unknown = await response.json();
    if (!isMatchingEvent(body, snapshot, idempotencyKey)) return "unknown";
    return "succeeded";
  }
}

export function eventIdForKey(idempotencyKey: string): string {
  // Google Calendar accepts base32hex characters; a hex digest is a valid subset.
  return `mp${createHash("sha256").update(`mailpilot-calendar-event-v1:${idempotencyKey}`).digest("hex")}`;
}

function buildCalendarEvent(snapshot: CalendarEventSnapshot, idempotencyKey: string): Record<string, unknown> {
  const { payload } = snapshot;
  return {
    id: eventIdForKey(idempotencyKey),
    summary: payload.title,
    ...(payload.location ? { location: payload.location } : {}),
    start: { dateTime: payload.startAt, timeZone: payload.timezone },
    end: { dateTime: payload.endAt, timeZone: payload.timezone },
    extendedProperties: {
      private: {
        mailpilotExecutionKey: idempotencyKey,
        mailpilotPayloadHash: snapshot.payloadHash,
        mailpilotSourceEmailId: payload.sourceEmailId
      }
    }
  };
}

function isMatchingEvent(value: unknown, snapshot: CalendarEventSnapshot, idempotencyKey: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  const extended = event.extendedProperties;
  if (typeof extended !== "object" || extended === null) return false;
  const privateProperties = (extended as Record<string, unknown>).private;
  if (typeof privateProperties !== "object" || privateProperties === null) return false;
  const fields = privateProperties as Record<string, unknown>;
  const start = typeof event.start === "object" && event.start !== null ? event.start as Record<string, unknown> : null;
  const end = typeof event.end === "object" && event.end !== null ? event.end as Record<string, unknown> : null;
  return event.status === "confirmed"
    && event.id === eventIdForKey(idempotencyKey)
    && event.summary === snapshot.payload.title
    && (event.location ?? null) === snapshot.payload.location
    && typeof start?.dateTime === "string"
    && Date.parse(start.dateTime) === Date.parse(snapshot.payload.startAt)
    && start.timeZone === snapshot.payload.timezone
    && typeof end?.dateTime === "string"
    && Date.parse(end.dateTime) === Date.parse(snapshot.payload.endAt)
    && end.timeZone === snapshot.payload.timezone
    && fields.mailpilotExecutionKey === idempotencyKey
    && fields.mailpilotPayloadHash === snapshot.payloadHash
    && fields.mailpilotSourceEmailId === snapshot.payload.sourceEmailId;
}

interface CalendarListEvent {
  id?: string;
  status?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
}

function parseEventList(value: unknown): { items: CalendarListEvent[]; nextPageToken: string | null } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.items)) return null;
  const items: CalendarListEvent[] = [];
  for (const item of record.items) {
    if (typeof item !== "object" || item === null) return null;
    const event = item as Record<string, unknown>;
    items.push({
      ...(typeof event.id === "string" ? { id: event.id } : {}),
      ...(typeof event.status === "string" ? { status: event.status } : {}),
      ...(isDateHolder(event.start) ? { start: event.start } : {}),
      ...(isDateHolder(event.end) ? { end: event.end } : {})
    });
  }
  return {
    items,
    nextPageToken: typeof record.nextPageToken === "string" ? record.nextPageToken : null
  };
}

function isDateHolder(value: unknown): value is { date?: string; dateTime?: string } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.date === "string" || typeof record.dateTime === "string";
}

function eventOverlaps(event: CalendarListEvent, snapshot: CalendarEventSnapshot): boolean {
  const start = event.start;
  const end = event.end;
  if (!start || !end) return true;
  if (start.date && end.date) {
    const proposedStartDate = snapshot.payload.startLocal.slice(0, 10);
    const endLocal = snapshot.payload.endLocal;
    const proposedEndDate = new Date(`${endLocal.slice(0, 10)}T00:00:00.000Z`);
    if (endLocal.slice(11) !== "00:00") proposedEndDate.setUTCDate(proposedEndDate.getUTCDate() + 1);
    const proposedEndExclusive = proposedEndDate.toISOString().slice(0, 10);
    return start.date < proposedEndExclusive && end.date > proposedStartDate;
  }
  if (!start.dateTime || !end.dateTime) return true;
  const existingStart = Date.parse(start.dateTime);
  const existingEnd = Date.parse(end.dateTime);
  const proposedStart = Date.parse(snapshot.payload.startAt);
  const proposedEnd = Date.parse(snapshot.payload.endAt);
  if (![existingStart, existingEnd, proposedStart, proposedEnd].every(Number.isFinite)) return true;
  return existingStart < proposedEnd && existingEnd > proposedStart;
}

function providerError(status: number): CalendarApiError {
  if (status === 401) return new CalendarApiError("unauthorized");
  if (status === 409) return new CalendarApiError("conflict");
  if (status === 408 || status === 429 || status >= 500) return new CalendarApiError("transient");
  return new CalendarApiError("permanent");
}
