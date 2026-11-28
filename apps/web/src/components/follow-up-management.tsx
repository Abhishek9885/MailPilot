"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  FollowUpManagementResponseSchema,
  FollowUpSettingsResponseSchema,
  FollowUpStatusResponseSchema,
  FollowUpUpdateRequestSchema,
  type FollowUpRecordSchema,
  type FollowUpSettingsSchema
} from "@mailpilot/shared";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { TextField } from "@/components/ui/field";
import { getCsrfToken } from "@/lib/csrf-token";
import { webEnvironment } from "@/lib/environment";

type FollowUpRecord = z.infer<typeof FollowUpRecordSchema>;
type FollowUpSettings = z.infer<typeof FollowUpSettingsSchema>;

const DEFAULT_SETTINGS: FollowUpSettings = {
  enabled: false,
  commitmentRemindersEnabled: true,
  staleThreadSuggestionsEnabled: true,
  commitmentLeadHours: 24,
  staleThreadAfterDays: 5,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  quietHoursStart: null,
  quietHoursEnd: null,
  dailySuggestionLimit: 5,
  updatedAt: null
};

export function FollowUpManagementPanel() {
  const [settings, setSettings] = useState<FollowUpSettings>(DEFAULT_SETTINGS);
  const [followUps, setFollowUps] = useState<FollowUpRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");

  const load = async (signal?: AbortSignal) => {
    const response = await fetch(new URL("/v1/follow-ups", webEnvironment.apiBaseUrl), {
      credentials: "include", cache: "no-store", ...(signal ? { signal } : {})
    });
    if (!response.ok) throw new Error("Follow-up suggestions could not be loaded.");
    const parsed = FollowUpManagementResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("The follow-up response was invalid.");
    setSettings(parsed.data.settings);
    setFollowUps(parsed.data.followUps);
    setError("");
    setLoading(false);
  };

  useEffect(() => {
    const controller = new AbortController();
    void fetch(new URL("/v1/follow-ups", webEnvironment.apiBaseUrl), {
      credentials: "include", cache: "no-store", signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) throw new Error("Follow-up suggestions could not be loaded.");
      const parsed = FollowUpManagementResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The follow-up response was invalid.");
      setSettings(parsed.data.settings);
      setFollowUps(parsed.data.followUps);
      setError("");
      setLoading(false);
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "Follow-up suggestions could not be loaded.");
      setLoading(false);
    });
    return () => controller.abort();
  }, []);

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const csrfToken = getCsrfToken();
    if (!csrfToken) { setError("Your session needs refreshing. Reload the page and try again."); return; }
    setSaving(true);
    setError("");
    try {
      const requestSettings = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "updatedAt"));
      const response = await fetch(new URL("/v1/follow-ups/settings", webEnvironment.apiBaseUrl), {
        method: "PATCH", credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(requestSettings)
      });
      if (!response.ok) throw new Error("Follow-up settings could not be saved.");
      const parsed = FollowUpSettingsResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The saved settings response was invalid.");
      setSettings(parsed.data.settings);
      setAnnouncement("Follow-up settings saved.");
      await load();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Follow-up settings could not be saved.");
    } finally { setSaving(false); }
  };

  const updateSuggestion = async (item: FollowUpRecord, action: "complete" | "dismiss" | "snooze") => {
    const csrfToken = getCsrfToken();
    if (!csrfToken) { setError("Your session needs refreshing. Reload the page and try again."); return; }
    const update = action === "snooze"
      ? { action: "snooze_one_day" as const }
      : { action };
    const parsedUpdate = FollowUpUpdateRequestSchema.safeParse(update);
    if (!parsedUpdate.success) return;
    try {
      const response = await fetch(new URL(`/v1/follow-ups/${encodeURIComponent(item.id)}`, webEnvironment.apiBaseUrl), {
        method: "PATCH", credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(parsedUpdate.data)
      });
      if (!response.ok) throw new Error("The suggestion could not be updated.");
      const parsed = FollowUpStatusResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The updated suggestion response was invalid.");
      setFollowUps((current) => action === "snooze"
        ? current.filter((existing) => existing.id !== item.id)
        : current.map((existing) => existing.id === item.id ? parsed.data.followUp : existing));
      setAnnouncement(action === "complete" ? "Follow-up marked done." : action === "dismiss" ? "Follow-up dismissed." : "Follow-up snoozed for one day.");
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "The suggestion could not be updated.");
    }
  };

  const setNumber = (key: "commitmentLeadHours" | "staleThreadAfterDays" | "dailySuggestionLimit", value: string) => {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) setSettings((current) => ({ ...current, [key]: parsed }));
  };

  const setQuietHour = (key: "quietHoursStart" | "quietHoursEnd", value: string) => {
    const parsed = value === "" ? null : Number(value);
    if (parsed === null || Number.isInteger(parsed)) setSettings((current) => ({ ...current, [key]: parsed }));
  };

  return (
    <Card className="task-board-card">
      <div className="task-board__header">
        <div>
          <p className="feature-eyebrow">Private, in-app suggestions</p>
          <h2>Follow-up reminders</h2>
          <p>Suggestions use active commitments and stale conversation timestamps. MailPilot will not send messages or change your calendar.</p>
        </div>
        <Button disabled={loading} onClick={() => { setLoading(true); void load().catch(() => { setError("Follow-up suggestions could not be loaded."); setLoading(false); }); }} size="sm" variant="secondary">Refresh</Button>
      </div>
      <div aria-live="polite" className="visually-hidden">{announcement}</div>
      {error && <p className="task-page-error" role="alert">{error}</p>}
      <form className="managed-task__editor follow-up-settings" onSubmit={(event) => { void saveSettings(event); }}>
        <label className="follow-up-toggle"><input checked={settings.enabled} onChange={(event) => setSettings((current) => ({ ...current, enabled: event.currentTarget.checked }))} type="checkbox" /> Enable follow-up suggestions</label>
        <div className="follow-up-settings__grid">
          <label className="follow-up-toggle"><input checked={settings.commitmentRemindersEnabled} onChange={(event) => setSettings((current) => ({ ...current, commitmentRemindersEnabled: event.currentTarget.checked }))} type="checkbox" /> Commitment reminders</label>
          <TextField label="Reminder lead time (hours)" max="168" min="0" onChange={(event) => setNumber("commitmentLeadHours", event.currentTarget.value)} type="number" value={String(settings.commitmentLeadHours)} />
          <label className="follow-up-toggle"><input checked={settings.staleThreadSuggestionsEnabled} onChange={(event) => setSettings((current) => ({ ...current, staleThreadSuggestionsEnabled: event.currentTarget.checked }))} type="checkbox" /> Stale thread suggestions</label>
          <TextField label="Stale after (days)" max="90" min="1" onChange={(event) => setNumber("staleThreadAfterDays", event.currentTarget.value)} type="number" value={String(settings.staleThreadAfterDays)} />
          <TextField autoComplete="off" label="Timezone (IANA name)" maxLength={64} onChange={(event) => setSettings((current) => ({ ...current, timeZone: event.currentTarget.value }))} placeholder="Asia/Kolkata" value={settings.timeZone} />
          <TextField label="Daily suggestion limit" max="20" min="1" onChange={(event) => setNumber("dailySuggestionLimit", event.currentTarget.value)} type="number" value={String(settings.dailySuggestionLimit)} />
          <label className="follow-up-toggle"><input checked={settings.quietHoursStart !== null && settings.quietHoursEnd !== null} onChange={(event) => {
            const enabled = event.currentTarget.checked;
            setSettings((current) => enabled
              ? { ...current, quietHoursStart: 22, quietHoursEnd: 7 }
              : { ...current, quietHoursStart: null, quietHoursEnd: null });
          }} type="checkbox" /> Use quiet hours</label>
          <label className="follow-up-hour">Quiet hours start<select aria-label="Quiet hours start" disabled={settings.quietHoursStart === null} onChange={(event) => setQuietHour("quietHoursStart", event.currentTarget.value)} value={settings.quietHoursStart === null ? "" : String(settings.quietHoursStart)}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}</select></label>
          <label className="follow-up-hour">Quiet hours end<select aria-label="Quiet hours end" disabled={settings.quietHoursEnd === null} onChange={(event) => setQuietHour("quietHoursEnd", event.currentTarget.value)} value={settings.quietHoursEnd === null ? "" : String(settings.quietHoursEnd)}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}</select></label>
        </div>
        <p className="follow-up-settings__hint">Suggestions are checked about every 15 minutes. Quiet hours use the timezone above.</p>
        <Button disabled={saving || loading} type="submit">{saving ? "Saving…" : "Save follow-up settings"}</Button>
      </form>
      {loading ? <p role="status">Loading follow-up suggestions…</p> : followUps.length === 0 ? (
        <div className="task-empty" role="status"><strong>No follow-up suggestions yet</strong><span>Enable reminders above. New suggestions will appear when a commitment is near its due date or a conversation becomes stale.</span></div>
      ) : (
        <ul className="managed-task-list">
          {followUps.map((item) => (
            <li className="managed-task" key={item.id}>
              <div className="managed-task__heading"><div><div className="task-list__title"><h3>{item.title}</h3><Badge tone={item.status === "completed" ? "green" : item.status === "dismissed" ? "neutral" : "amber"}>{item.status}</Badge></div><p>{item.reason}</p></div></div>
              <section aria-label="Follow-up source" className="managed-task__source"><h4>Source conversation</h4><Link href={`/inbox?emailId=${encodeURIComponent(item.sourceEmail.id)}`}>{item.sourceEmail.subject || "Open source email"}</Link><p>{[item.sourceEmail.senderEmail, `Thread ${item.sourceThreadId}`, `Message ${item.sourceEmail.id}`, `Received ${new Date(item.sourceEmail.receivedAt).toLocaleString()}`].filter(Boolean).join(" · ")}</p>{item.commitment && <blockquote>{item.commitment.evidence}</blockquote>}</section>
              {item.status === "planned" && <div className="managed-task__actions"><Button onClick={() => { void updateSuggestion(item, "complete"); }} size="sm">Done</Button><Button onClick={() => { void updateSuggestion(item, "snooze"); }} size="sm" variant="secondary">Snooze 1 day</Button><Button onClick={() => { void updateSuggestion(item, "dismiss"); }} size="sm" variant="ghost">Dismiss</Button></div>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
