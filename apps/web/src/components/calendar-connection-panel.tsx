"use client";

import { useEffect, useState } from "react";
import {
  GoogleCalendarConnectionResponseSchema,
  GoogleCalendarScope,
  ServiceErrorSchema,
  type GoogleCalendarConnectionResponse
} from "@mailpilot/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { webEnvironment } from "@/lib/environment";
import { getCsrfToken } from "@/lib/csrf-token";

type LoadState = "loading" | "ready" | "error";

function callbackError(code: string): string {
  switch (code) {
    case "unavailable": return "Google Calendar OAuth is not configured in the API environment.";
    case "access_denied": return "Calendar access was declined.";
    case "scope_missing": return "Google did not grant the event creation permission. Reconnect Calendar and grant the requested scope.";
    case "refresh_token_missing": return "Google did not return offline access. Reconnect Calendar and approve the permission prompt.";
    case "invalid_state": return "The Calendar connection expired. Start the connection again.";
    default: return "Google Calendar could not be connected. Check the OAuth client and callback settings.";
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const parsed = ServiceErrorSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.error.message : "Calendar connection could not be updated.";
  } catch {
    return "Calendar connection could not be updated.";
  }
}

export function CalendarConnectionPanel() {
  const [state, setState] = useState<LoadState>("loading");
  const [connection, setConnection] = useState<GoogleCalendarConnectionResponse | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const url = new URL(window.location.href);
    const connected = url.searchParams.get("calendar");
    const callback = url.searchParams.get("calendar_error");
    const callbackNotice = connected === "connected" ? "Google Calendar is connected." : callback ? callbackError(callback) : "";
    if (connected || callback) {
      url.searchParams.delete("calendar");
      url.searchParams.delete("calendar_error");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    const controller = new AbortController();
    void fetch(new URL("/v1/calendar/connection", webEnvironment.apiBaseUrl), {
      credentials: "include", cache: "no-store", signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) throw new Error(await errorMessage(response));
      const parsed = GoogleCalendarConnectionResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The Calendar connection response was invalid.");
      if (callbackNotice) setNotice(callbackNotice);
      setConnection(parsed.data);
      setState("ready");
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "Calendar connection could not be loaded.");
      setState("error");
    });
    return () => controller.abort();
  }, []);

  const connectUrl = new URL("/v1/calendar/connect", webEnvironment.apiBaseUrl);
  connectUrl.searchParams.set("returnTo", "/settings");
  const active = connection?.connection?.status === "active";

  const disconnect = async () => {
    const csrfToken = getCsrfToken();
    if (!csrfToken) { setError("Your session needs refreshing. Reload and try again."); return; }
    setError("");
    try {
      const response = await fetch(new URL("/v1/calendar/connection", webEnvironment.apiBaseUrl), {
        method: "DELETE", credentials: "include", headers: { "x-csrf-token": csrfToken }
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      setConnection((current) => current ? { ...current, connection: current.connection ? { ...current.connection, status: "disconnected", reauthRequired: false } : null } : null);
      setNotice("Google Calendar was disconnected.");
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Calendar could not be disconnected.");
    }
  };

  return (
    <Card className="gmail-connection-card calendar-connection-card">
      <div className="feature-card__header">
        <div><p className="feature-eyebrow">Optional calendar access</p><h2>Connect Google Calendar</h2><p>MailPilot uses a separate Google grant to create events only after you approve the exact event proposal.</p></div>
        <Badge dot tone={active ? "green" : state === "error" ? "red" : "neutral"}>
          {state === "loading" ? "Checking" : state === "error" ? "Unavailable" : active ? "Connected" : "Not connected"}
        </Badge>
      </div>
      {state === "error" && <p className="gmail-connection-card__error" role="alert">{error}</p>}
      {state === "loading" && <p className="gmail-connection-card__copy" role="status">Checking Calendar connection…</p>}
      {notice && <p className="gmail-connection-card__notice" role="status">{notice}</p>}
      {error && state === "ready" && <p className="gmail-connection-card__error" role="alert">{error}</p>}
      {state === "ready" && <>
        {connection?.connection && <p className="gmail-connection-card__account">{connection.connection.email}{connection.connection.reauthRequired ? " · Reauthorization needed" : ""}</p>}
        <div className="gmail-connection-card__actions">
          {active ? <Button onClick={() => { void disconnect(); }} variant="secondary">Disconnect Calendar</Button>
            : <a className="button button--primary button--md" href={connectUrl.toString()}>{connection?.connection?.reauthRequired ? "Reconnect Calendar" : "Connect Calendar"}</a>}
        </div>
        {connection && !connection.eventCreationEnabled && <p className="gmail-connection-card__copy">Event creation stays disabled until <code>GOOGLE_CALENDAR_EVENTS_ENABLED=true</code> is configured in the API environment.</p>}
      </>}
      {!active && <details className="gmail-setup-help">
        <summary>Local Calendar OAuth setup</summary>
        <p>Enable Google Calendar API and add this narrow events scope under Google Auth Platform → Data Access:</p>
        <code>{GoogleCalendarScope}</code>
        <p>Authorized redirect URI:</p>
        <code>http://localhost:4000/v1/oauth/google-calendar/callback</code>
        <p>Set <code>GOOGLE_CALENDAR_OAUTH_CLIENT_ID</code> and <code>GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET</code> in the repository <code>.env</code>. This connection uses its own OAuth client and encrypted refresh token.</p>
      </details>}
    </Card>
  );
}
