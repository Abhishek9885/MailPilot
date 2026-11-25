"use client";

import { useState } from "react";
import {
  ActionProposalResponseSchema,
  ServiceErrorSchema,
  type EmailEventCandidate,
  type SyncedEmailSummary
} from "@mailpilot/shared";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { webEnvironment } from "@/lib/environment";
import { getCsrfToken } from "@/lib/csrf-token";

function initialLocalDateTime(date: string | null, time: string | null): string {
  if (!date || !time) return "";
  return `${date}T${time.slice(0, 5)}`;
}

function localTimeToIso(localValue: string, timezone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localValue);
  if (!match) throw new Error("Enter a valid local date and time.");
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const values = [yearText, monthText, dayText, hourText, minuteText].map(Number);
  const [year, month, day, hour, minute] = values;
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined) {
    throw new Error("Enter a valid local date and time.");
  }
  const naiveLocal = Date.UTC(year, month - 1, day, hour, minute);
  const checkDate = new Date(naiveLocal);
  if (checkDate.getUTCFullYear() !== year || checkDate.getUTCMonth() !== month - 1
    || checkDate.getUTCDate() !== day || checkDate.getUTCHours() !== hour || checkDate.getUTCMinutes() !== minute) {
    throw new Error("Enter a valid local date and time.");
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA-u-hc-h23", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    });
  } catch {
    throw new Error("Choose a valid IANA time zone, such as Asia/Kolkata or America/New_York.");
  }
  const getParts = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant));
    const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return [read("year"), read("month"), read("day"), read("hour"), read("minute"), read("second")];
  };
  const candidates = new Set<number>();
  for (let deltaHours = -36; deltaHours <= 36; deltaHours += 3) {
    const sample = naiveLocal + deltaHours * 60 * 60_000;
    const [sampleYear, sampleMonth, sampleDay, sampleHour, sampleMinute, sampleSecond] = getParts(sample);
    const representedLocal = Date.UTC(sampleYear ?? 0, (sampleMonth ?? 1) - 1, sampleDay, sampleHour, sampleMinute, sampleSecond);
    const candidate = naiveLocal - (representedLocal - sample);
    const [candidateYear, candidateMonth, candidateDay, candidateHour, candidateMinute] = getParts(candidate);
    if (candidateYear === year && candidateMonth === month && candidateDay === day
      && candidateHour === hour && candidateMinute === minute) candidates.add(candidate);
  }
  if (candidates.size === 0) throw new Error("That local time does not exist because the time zone changes its clock then.");
  if (candidates.size > 1) throw new Error("That local time occurs twice when clocks change. Choose a different time before proposing it.");
  const instant = [...candidates][0];
  if (instant === undefined) throw new Error("This date and time could not be resolved.");
  return new Date(instant).toISOString();
}

async function apiErrorMessage(response: Response): Promise<string> {
  try {
    const parsed = ServiceErrorSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.error.message : "The event proposal could not be saved.";
  } catch {
    return "The event proposal could not be saved.";
  }
}

export function CalendarEventProposal({
  event,
  email
}: {
  event: EmailEventCandidate;
  email: SyncedEmailSummary;
}) {
  const [title, setTitle] = useState(event.title);
  const [startLocal, setStartLocal] = useState(initialLocalDateTime(event.startDate, event.startTime));
  const [endLocal, setEndLocal] = useState(initialLocalDateTime(event.endDate, event.endTime));
  const [timezone, setTimezone] = useState(() => {
    if (event.timezone) {
      try { new Intl.DateTimeFormat(undefined, { timeZone: event.timezone }); return event.timezone; } catch { /* user must choose a valid zone */ }
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  });
  const [location, setLocation] = useState(event.location ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const saveProposal = async () => {
    setError("");
    setNotice("");
    let startAt: string;
    let endAt: string;
    try {
      startAt = localTimeToIso(startLocal, timezone);
      endAt = localTimeToIso(endLocal, timezone);
      if (Date.parse(endAt) <= Date.parse(startAt)) throw new Error("The end must be later than the start.");
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Enter a valid event time.");
      return;
    }
    if (!crypto.randomUUID) { setError("Reload this page in a secure browser before creating a proposal."); return; }
    const csrfToken = getCsrfToken();
    if (!csrfToken) { setError("Your session needs refreshing. Reload the page and try again."); return; }

    setBusy(true);
    try {
      const response = await fetch(new URL("/v1/actions/proposals", webEnvironment.apiBaseUrl), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          agentRunId: null,
          idempotencyKey: crypto.randomUUID(),
          actionType: "create_calendar_event",
          payload: {
            title, startAt, endAt, startLocal, endLocal, timezone,
            location: location.trim() || null, sourceEmailId: email.id
          },
          sourceEvidence: [{ emailId: email.id, threadId: email.threadId, sourceRevision: email.sourceRevision, quote: event.evidence }]
        })
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response));
      const parsed = ActionProposalResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The event proposal response was invalid.");
      setNotice("Saved for review. Open Approvals to approve this exact event before it can be created.");
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "The event proposal could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="calendar-event-proposal">
      <strong>{event.title}</strong>
      <blockquote>{event.evidence}</blockquote>
      <div className="calendar-event-proposal__fields">
        <TextField label="Event title" maxLength={200} onChange={(change) => setTitle(change.currentTarget.value)} value={title} />
        <TextField label="Start" onChange={(change) => setStartLocal(change.currentTarget.value)} type="datetime-local" value={startLocal} />
        <TextField label="End" onChange={(change) => setEndLocal(change.currentTarget.value)} type="datetime-local" value={endLocal} />
        <TextField hint="Use an IANA zone such as Asia/Kolkata. Ambiguous or nonexistent daylight-saving times are blocked." label="Time zone" maxLength={64} onChange={(change) => setTimezone(change.currentTarget.value.trim())} value={timezone} />
        <TextField label="Location (optional)" maxLength={240} onChange={(change) => setLocation(change.currentTarget.value)} value={location} />
      </div>
      <p className="calendar-event-proposal__preview"><strong>Preview:</strong> {title || "(No title)"} · {startLocal || "Start not set"} to {endLocal || "End not set"} · {timezone || "Time zone not set"}{location ? ` · ${location}` : ""}</p>
      {error && <p className="gmail-connection-card__error" role="alert">{error}</p>}
      {notice && <p className="gmail-connection-card__notice" role="status">{notice}</p>}
      <p className="ai-workspace__microcopy">No attendees are added. Saving this proposal does not create a Calendar event.</p>
      <Button disabled={busy} onClick={() => { void saveProposal(); }} variant="secondary">{busy ? "Saving proposal…" : "Send event to Approvals"}</Button>
    </li>
  );
}
