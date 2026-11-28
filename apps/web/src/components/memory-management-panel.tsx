"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  MemoryManagementResponseSchema,
  MemoryRetrievalResponseSchema,
  MemorySettingsResponseSchema,
  MemoryItemResponseSchema,
  ServiceErrorSchema,
  SyncedEmailListResponseSchema,
  USER_MEMORY_CONSENT_VERSION,
  type MemoryRecurrence,
  type UserMemory
} from "@mailpilot/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { webEnvironment } from "@/lib/environment";
import { getCsrfToken } from "@/lib/csrf-token";

type MemoryType = UserMemory["type"];
type MemoryData = ReturnType<typeof MemoryManagementResponseSchema.parse>;
const API = webEnvironment.apiBaseUrl;

function settingError(response: Response, fallback: string): Promise<string> {
  if (response.status === 401) return Promise.resolve("Your session expired. Sign in again to manage saved memory.");
  return response.json().then((body: unknown) => {
    const parsed = ServiceErrorSchema.safeParse(body);
    return parsed.success ? parsed.data.error.message : fallback;
  }).catch(() => fallback);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function typeLabel(type: MemoryType): string {
  if (type === "preference") return "Preference";
  if (type === "recurring_commitment") return "Recurring commitment";
  return "Relevant fact";
}

function recurrenceDescription(recurrence: MemoryRecurrence | null): string {
  if (!recurrence) return "";
  const cadence = recurrence.frequency === "weekly"
    ? `weekly on ${recurrence.weekdays.map((day) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day - 1]).join(", ")}`
    : recurrence.frequency;
  return `Repeats ${cadence} in ${recurrence.timezone}${recurrence.endsOn ? ` until ${recurrence.endsOn}` : ""}.`;
}

export function MemoryManagementPanel() {
  const [data, setData] = useState<MemoryData | null>(null);
  const [sourceEmails, setSourceEmails] = useState<ReturnType<typeof SyncedEmailListResponseSchema.parse>["emails"]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [consentChecked, setConsentChecked] = useState(false);
  const [editing, setEditing] = useState<UserMemory | null>(null);
  const [type, setType] = useState<MemoryType>("relevant_fact");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [sourceEmailId, setSourceEmailId] = useState("");
  const [frequency, setFrequency] = useState<MemoryRecurrence["frequency"]>("weekly");
  const [interval, setInterval] = useState("1");
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [monthDay, setMonthDay] = useState("1");
  const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [endsOn, setEndsOn] = useState("");
  const [query, setQuery] = useState("");
  const [retrieved, setRetrieved] = useState<UserMemory[]>([]);
  const [retrievalPreviewed, setRetrievalPreviewed] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(new URL("/v1/memories", API), { credentials: "include", cache: "no-store", ...(signal ? { signal } : {}) });
    if (!response.ok) throw new Error(await settingError(response, "Saved memory could not be loaded."));
    const parsed = MemoryManagementResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("The saved memory response was invalid.");
    let emails: ReturnType<typeof SyncedEmailListResponseSchema.parse>["emails"] = [];
    try {
      const emailResponse = await fetch(new URL("/v1/emails?limit=50", API), { credentials: "include", cache: "no-store", ...(signal ? { signal } : {}) });
      if (emailResponse.ok) {
        const parsedEmails = SyncedEmailListResponseSchema.safeParse(await emailResponse.json());
        if (parsedEmails.success) emails = parsedEmails.data.emails;
      }
    } catch {
      // Source metadata remains visible for saved items even when the email selector is unavailable.
    }
    return { data: parsed.data, emails };
  }, []);

  const refresh = async () => {
    const loaded = await load();
    setData(loaded.data);
    setSourceEmails(loaded.emails);
  };

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then((loaded) => {
      setData(loaded.data);
      setSourceEmails(loaded.emails);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Saved memory could not be loaded.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [load]);

  const resetForm = () => {
    setEditing(null);
    setType("relevant_fact");
    setKey("");
    setValue("");
    setSourceEmailId("");
    setFrequency("weekly");
    setInterval("1");
    setWeekdays([1]);
    setMonthDay("1");
    setTimezone("Asia/Kolkata");
    setEndsOn("");
  };

  const startEditing = (memory: UserMemory) => {
    setEditing(memory);
    setType(memory.type);
    setKey(memory.key);
    setValue(memory.value);
    setSourceEmailId(memory.source.email?.id ?? "");
    const recurrence = memory.recurrence;
    setFrequency(recurrence?.frequency ?? "weekly");
    setInterval(String(recurrence?.interval ?? 1));
    setWeekdays(recurrence?.weekdays ?? [1]);
    setMonthDay(String(recurrence?.monthDay ?? 1));
    setTimezone(recurrence?.timezone ?? "Asia/Kolkata");
    setEndsOn(recurrence?.endsOn ?? "");
  };

  const csrfHeaders = (): HeadersInit => {
    const token = getCsrfToken();
    if (!token) throw new Error("Your session needs refreshing. Reload the page and try again.");
    return { "content-type": "application/json", "x-csrf-token": token };
  };

  const saveSettings = async (mode: "enabled" | "paused" | "disabled") => {
    if (mode === "enabled" && data?.settings.mode === "disabled" && !consentChecked) {
      setError("Review and accept the memory consent notice before enabling it.");
      return;
    }
    if (mode === "disabled" && !window.confirm("Turn off memory and permanently delete every saved memory? This cannot be undone.")) return;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(new URL("/v1/memories/settings", API), {
        method: "PATCH",
        credentials: "include",
        headers: csrfHeaders(),
        body: JSON.stringify(mode === "enabled" ? { mode, consentVersion: USER_MEMORY_CONSENT_VERSION } : { mode })
      });
      if (!response.ok) throw new Error(await settingError(response, "Memory settings could not be updated."));
      const parsed = MemorySettingsResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The memory settings response was invalid.");
      await refresh();
      setConsentChecked(false);
      setRetrieved([]);
      setRetrievalPreviewed(false);
      setNotice(mode === "disabled" ? "Memory is off and saved items were deleted." : mode === "paused" ? "Memory retrieval is paused. Saved items remain until their expiry." : "Memory is enabled for items you explicitly save.");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Memory settings could not be updated.");
    } finally {
      setWorking(false);
    }
  };

  const submitMemory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setWorking(true);
    setError("");
    setNotice("");
    try {
      let recurrence: MemoryRecurrence | null = null;
      if (type === "recurring_commitment") {
        recurrence = {
          frequency,
          interval: Number(interval),
          weekdays: frequency === "weekly" ? weekdays : [],
          monthDay: frequency === "monthly" ? Number(monthDay) : null,
          timezone,
          endsOn: endsOn || null
        };
      }
      const payload = {
        type,
        key,
        value,
        sourceEmailId: sourceEmailId || null,
        recurrence,
        ...(editing ? { expectedRevision: editing.revision } : {})
      };
      const response = await fetch(new URL(editing ? `/v1/memories/${encodeURIComponent(editing.id)}` : "/v1/memories", API), {
        method: editing ? "PATCH" : "POST",
        credentials: "include",
        headers: csrfHeaders(),
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(await settingError(response, "This memory could not be saved."));
      const parsed = MemoryItemResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The saved memory response was invalid.");
      await refresh();
      setRetrieved([]);
      setRetrievalPreviewed(false);
      setNotice(editing ? "Memory updated. Its previous value was replaced." : "Memory saved and approved by you.");
      resetForm();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "This memory could not be saved.");
    } finally {
      setWorking(false);
    }
  };

  const deleteMemory = async (memory: UserMemory) => {
    if (!window.confirm(`Delete the saved memory “${memory.key}”?`)) return;
    setWorking(true);
    setError("");
    try {
      const response = await fetch(new URL(`/v1/memories/${encodeURIComponent(memory.id)}`, API), {
        method: "DELETE", credentials: "include", headers: csrfHeaders()
      });
      if (!response.ok) throw new Error(await settingError(response, "This memory could not be deleted."));
      if (editing?.id === memory.id) resetForm();
      await refresh();
      setRetrieved([]);
      setRetrievalPreviewed(false);
      setNotice("Memory deleted.");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "This memory could not be deleted.");
    } finally {
      setWorking(false);
    }
  };

  const confirmMemory = async (memory: UserMemory) => {
    setWorking(true);
    setError("");
    try {
      const response = await fetch(new URL(`/v1/memories/${encodeURIComponent(memory.id)}/confirm`, API), {
        method: "POST", credentials: "include", headers: csrfHeaders()
      });
      if (!response.ok) throw new Error(await settingError(response, "This memory could not be confirmed."));
      const parsed = MemoryItemResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The memory confirmation response was invalid.");
      await refresh();
      setRetrieved([]);
      setRetrievalPreviewed(false);
      setNotice("Memory confirmed with a fresh expiry date.");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "This memory could not be confirmed.");
    } finally {
      setWorking(false);
    }
  };

  const previewRetrieval = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setWorking(true);
    setError("");
    try {
      const response = await fetch(new URL("/v1/memories/retrieve", API), {
        method: "POST", credentials: "include", headers: csrfHeaders(), body: JSON.stringify({ query })
      });
      if (!response.ok) throw new Error(await settingError(response, "Memory retrieval could not be previewed."));
      const parsed = MemoryRetrievalResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The memory retrieval response was invalid.");
      setRetrieved(parsed.data.memories);
      setRetrievalPreviewed(true);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Memory retrieval could not be previewed.");
    } finally {
      setWorking(false);
    }
  };

  const currentMode = data?.settings.mode ?? "disabled";
  const canAdd = currentMode === "enabled" && data !== null && data.memories.length < 50;
  const supportsPreference = type === "preference";
  const consented = currentMode !== "disabled";

  return (
    <Card className="memory-management-card">
      <div className="feature-card__header memory-management-card__header">
        <div>
          <p className="feature-eyebrow">Private saved context</p>
          <h2>Memory</h2>
          <p>Only items you save are stored. Email text cannot create or replace a memory by itself.</p>
        </div>
        <Badge tone={currentMode === "enabled" ? "green" : currentMode === "paused" ? "amber" : "neutral"} dot>
          {currentMode === "enabled" ? "Enabled" : currentMode === "paused" ? "Paused" : "Off"}
        </Badge>
      </div>

      {error && <p className="memory-message memory-message--error" role="alert">{error}</p>}
      {notice && <p className="memory-message" role="status">{notice}</p>}

      {currentMode === "disabled" && data !== null && <div className="memory-consent">
        <p>Memory stores preferences, recurring commitments, and short non-sensitive facts that you explicitly save. Saved values are account-scoped, shown with their source, and expire unless you confirm them again. Email analysis does not currently use memory; future model use would require a separate notice if its purpose changes.</p>
        <label className="settings-checkbox"><input checked={consentChecked} onChange={(event) => setConsentChecked(event.currentTarget.checked)} type="checkbox" /><span><strong>Enable memory for this account</strong><small>I understand I can inspect, correct, pause, or delete saved items at any time.</small></span></label>
        <Button disabled={working || !consentChecked} onClick={() => void saveSettings("enabled")}>Enable memory</Button>
      </div>}

      {consented && <div className="memory-mode-controls">
        <p>{currentMode === "paused" ? "Saved items remain stored until they expire. Retrieval is currently disabled." : "Only active, unexpired items can appear in retrieval results."}</p>
        {currentMode === "enabled"
          ? <Button disabled={working} onClick={() => void saveSettings("paused")} variant="secondary">Pause retrieval</Button>
          : <Button disabled={working} onClick={() => void saveSettings("enabled")} variant="secondary">Resume memory</Button>}
        <Button disabled={working} onClick={() => void saveSettings("disabled")} variant="danger">Turn off and delete all</Button>
      </div>}

      {loading ? <p className="memory-empty-state">Loading saved memory…</p> : error && !data ? <p className="memory-empty-state">Memory controls are unavailable until the API can be reached.</p> : <>
        {currentMode !== "disabled" && <section aria-labelledby="memory-list-heading" className="memory-list-section">
          <div className="memory-section-heading"><div><h3 id="memory-list-heading">Saved items</h3><p>{data?.memories.length ?? 0} of 50 items</p></div></div>
          {!data?.memories.length ? <p className="memory-empty-state">No saved memory yet. Add an item below; synced email remains separate until you choose a value and save it.</p> :
            <ul className="memory-list">
              {data.memories.map((memory) => <li className="memory-item" key={memory.id}>
                <div className="memory-item__heading">
                  <div><Badge tone="blue">{typeLabel(memory.type)}</Badge><strong>{memory.key}</strong></div>
                  <Badge tone={memory.status === "active" ? "green" : memory.status === "stale" ? "amber" : "neutral"}>{memory.status}</Badge>
                </div>
                <p className="memory-item__value">{memory.value}</p>
                {memory.recurrence && <p className="memory-item__meta">{recurrenceDescription(memory.recurrence)}</p>}
                <p className="memory-item__meta">Saved {formatDate(memory.approvedAt)} · Expires {formatDate(memory.expiresAt)} · User-confirmed</p>
                {memory.source.email ? <p className="memory-item__source"><strong>Source email:</strong> {memory.source.email.subject} · {memory.source.email.senderEmail ?? "Unknown sender"} · {formatDate(memory.source.email.receivedAt)} · thread {memory.source.email.threadId} · saved revision {memory.source.email.sourceRevision}{memory.source.email.currentRevision !== memory.source.email.sourceRevision ? `, current revision ${memory.source.email.currentRevision}` : ""}{memory.status === "stale" ? " · source changed; edit and save to review the current version" : ""}</p> : <p className="memory-item__meta">Source: entered directly by you</p>}
                <div className="memory-item__actions">
                  <Button disabled={working} onClick={() => startEditing(memory)} size="sm" variant="secondary">Edit / correct</Button>
                  {memory.status !== "active" && <Button disabled={working || memory.status === "stale"} onClick={() => void confirmMemory(memory)} size="sm" variant="ghost">Confirm again</Button>}
                  <Button disabled={working} onClick={() => void deleteMemory(memory)} size="sm" variant="danger">Delete</Button>
                </div>
              </li>)}
            </ul>}
        </section>}

        {currentMode !== "disabled" && <section aria-labelledby="memory-form-heading" className="memory-editor">
          <div className="memory-section-heading"><div><h3 id="memory-form-heading">{editing ? "Correct saved memory" : "Add a memory"}</h3><p>{editing ? "Saving replaces the current value and creates a new revision." : "Saving here is your explicit approval for this exact value."}</p></div>{editing && <Button onClick={resetForm} size="sm" variant="ghost">Cancel edit</Button>}</div>
          <form className="memory-form" onSubmit={(event) => void submitMemory(event)}>
            <SelectField label="Memory type" onChange={(event) => { setType(event.currentTarget.value as MemoryType); setKey(""); setValue(""); }} value={type}>
              <option value="preference">Preference</option>
              <option value="recurring_commitment">Recurring commitment</option>
              <option value="relevant_fact">Relevant fact</option>
            </SelectField>
            {supportsPreference ? <SelectField label="Preference" onChange={(event) => { setKey(event.currentTarget.value); setValue(event.currentTarget.value === "reply_tone" ? "concise" : event.currentTarget.value === "response_language" ? "English" : "Asia/Kolkata"); }} required value={key}>
              <option value="">Choose a preference</option><option value="reply_tone">Reply tone</option><option value="response_language">Response language</option><option value="display_timezone">Display time zone</option>
            </SelectField> : <TextField label={type === "recurring_commitment" ? "Commitment key" : "Fact key"} maxLength={96} onChange={(event) => setKey(event.currentTarget.value)} placeholder={type === "recurring_commitment" ? "weekly_team_check_in" : "preferred_project_tool"} required value={key} />}
            {supportsPreference && key === "reply_tone" ? <SelectField label="Value" onChange={(event) => setValue(event.currentTarget.value)} value={value || "concise"}><option value="concise">Concise</option><option value="warm">Warm</option><option value="formal">Formal</option><option value="friendly">Friendly</option></SelectField>
              : supportsPreference && key === "response_language" ? <SelectField label="Value" onChange={(event) => setValue(event.currentTarget.value)} value={value || "English"}>{["English", "Spanish", "French", "German", "Hindi", "Italian", "Japanese", "Portuguese"].map((language) => <option key={language} value={language}>{language}</option>)}</SelectField>
                : supportsPreference && key === "display_timezone" ? <TextField label="Value (IANA time zone)" maxLength={64} onChange={(event) => setValue(event.currentTarget.value)} placeholder="Asia/Kolkata" value={value || "Asia/Kolkata"} />
                  : type === "relevant_fact" ? <TextAreaField hint="Keep it short and non-sensitive. Do not save credentials or instructions for the agent." label="Value" maxLength={300} onChange={(event) => setValue(event.currentTarget.value)} required rows={3} value={value} />
                    : type === "recurring_commitment" ? <TextField label="Commitment" maxLength={300} onChange={(event) => setValue(event.currentTarget.value)} placeholder="Prepare the monthly finance summary" required value={value} /> : null}

            {type === "recurring_commitment" && <div className="memory-recurrence">
              <SelectField label="Repeats" onChange={(event) => setFrequency(event.currentTarget.value as MemoryRecurrence["frequency"])} value={frequency}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></SelectField>
              <TextField label="Every N periods" max={12} min={1} onChange={(event) => setInterval(event.currentTarget.value)} required type="number" value={interval} />
              {frequency === "weekly" && <fieldset className="memory-weekdays"><legend>Days (select at least one)</legend>{[[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"]].map(([day, label]) => <label key={day}><input checked={weekdays.includes(Number(day))} onChange={(event) => { const checked = event.currentTarget.checked; const selectedDay = Number(day); setWeekdays((current) => checked ? [...current, selectedDay].sort() : current.length > 1 ? current.filter((item) => item !== selectedDay) : current); }} type="checkbox" />{label}</label>)}</fieldset>}
              {frequency === "monthly" && <TextField label="Day of month" max={31} min={1} onChange={(event) => setMonthDay(event.currentTarget.value)} type="number" value={monthDay} />}
              <TextField label="Time zone" maxLength={64} onChange={(event) => setTimezone(event.currentTarget.value)} required value={timezone} />
              <TextField label="Ends on (optional)" onChange={(event) => setEndsOn(event.currentTarget.value)} type="date" value={endsOn} />
            </div>}

            <SelectField hint="Choosing an email only records provenance. Its contents cannot update this value later." label="Source email (optional)" onChange={(event) => setSourceEmailId(event.currentTarget.value)} value={sourceEmailId}>
              <option value="">Entered directly by me</option>
              {sourceEmails.map((email) => <option key={email.id} value={email.id}>{email.subject} · {email.senderEmail ?? "Unknown sender"} · {formatDate(email.receivedAt)}</option>)}
            </SelectField>
            <div className="memory-item__actions"><Button disabled={working || (!editing && !canAdd)} type="submit">{working ? "Saving…" : editing ? "Save correction" : "Save memory"}</Button>{editing && <Button onClick={resetForm} type="button" variant="ghost">Cancel</Button>}</div>
            {!editing && currentMode === "paused" && <p className="memory-item__meta">Resume memory to add new items. You can still correct or delete saved items while paused.</p>}
            {data && data.memories.length >= 50 && !editing && <p className="memory-item__meta">The 50-item limit is reached. Delete an item before adding another.</p>}
          </form>
        </section>}

        {currentMode !== "disabled" && <section aria-labelledby="memory-retrieval-heading" className="memory-retrieval">
          <div className="memory-section-heading"><div><h3 id="memory-retrieval-heading">Retrieval preview</h3><p>See which saved items match a query. This preview does not send anything to an AI provider.</p></div></div>
          <form className="memory-retrieval__form" onSubmit={(event) => void previewRetrieval(event)}>
            <TextField label="Query" maxLength={500} onChange={(event) => { setQuery(event.currentTarget.value); setRetrievalPreviewed(false); }} placeholder="How should my replies sound?" required value={query} />
            <Button disabled={working || currentMode !== "enabled"} type="submit" variant="secondary">Preview retrieval</Button>
          </form>
          {retrieved.length > 0 ? <ul className="memory-retrieval__results">{retrieved.map((memory) => <li key={memory.id}><strong>{memory.key}</strong><span>{memory.value}</span><Badge tone="blue">{Math.round((memory.relevanceScore ?? 0) * 100)}% match</Badge></li>)}</ul> : retrievalPreviewed && <p className="memory-item__meta">No matching memories in the last preview.</p>}
        </section>}
      </>}
    </Card>
  );
}
