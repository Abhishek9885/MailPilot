"use client";

import { useEffect, useRef, useState } from "react";
import {
  GmailActiveSyncResponseSchema,
  GmailConnectionResponseSchema,
  GmailSyncResponseSchema,
  ServiceErrorSchema,
  type GmailConnectionResponse,
  type GmailSyncProgress
} from "@mailpilot/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { webEnvironment } from "@/lib/environment";
import { getCsrfToken } from "@/lib/csrf-token";

type ConnectionState = "loading" | "ready" | "error";
type SyncState = "idle" | "starting" | "syncing" | "partial" | "error";

async function responseError(response: Response, fallback: string): Promise<string> {
  if (response.status === 401) return "Your MailPilot session expired. Sign in again and reconnect Gmail.";
  try {
    const parsed = ServiceErrorSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.error.message : fallback;
  } catch {
    return fallback;
  }
}

function oauthErrorMessage(code: string): string {
  switch (code) {
    case "unavailable":
      return "Gmail authorization is not configured in the API environment yet. Add the Gmail OAuth client values to the repository .env file and restart the API.";
    case "access_denied":
      return "Google did not grant Gmail access. Try again and approve the read-only mailbox permission.";
    case "invalid_code":
    case "oauth_failed":
      return "Google could not verify this Gmail connection. Check the Gmail OAuth redirect URI and try again.";
    default:
      return "Gmail could not be connected. Check the OAuth settings and try again.";
  }
}

function syncStatusLabel(progress: GmailSyncProgress): string {
  if (progress.status === "completed") return "Sync complete";
  if (progress.status === "failed") return "Sync failed";
  if (progress.status === "resync_required") return "Reconnect required";
  if (progress.status === "cancelled") return "Sync cancelled";
  return "Syncing Gmail";
}

export function GmailConnectionPanel() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("loading");
  const [connection, setConnection] = useState<GmailConnectionResponse["connection"]>(null);
  const [connectionError, setConnectionError] = useState("");
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [syncProgress, setSyncProgress] = useState<GmailSyncProgress | null>(null);
  const [syncError, setSyncError] = useState("");
  const [notice, setNotice] = useState("");
  const syncController = useRef<AbortController | null>(null);
  const [syncMonitorVersion, setSyncMonitorVersion] = useState(0);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const connected = query.get("gmail");
    const oauthError = query.get("error");
    const redirectNotice = connected === "connected"
      ? "Gmail is connected. Start a sync to load messages into MailPilot."
      : oauthError ? oauthErrorMessage(oauthError) : "";

    if (connected || oauthError) {
      query.delete("gmail");
      query.delete("error");
      const queryString = query.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${queryString ? `?${queryString}` : ""}${window.location.hash}`);
    }

    const controller = new AbortController();
    void fetch(new URL("/v1/gmail/connection", webEnvironment.apiBaseUrl), {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response, "Gmail connection status could not be loaded."));
      const parsed = GmailConnectionResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The Gmail connection response was invalid.");
      if (controller.signal.aborted) return;
      if (redirectNotice) setNotice(redirectNotice);
      setConnection(parsed.data.connection);
      setConnectionState("ready");
      if (parsed.data.connection?.status === "active") {
        const activeResponse = await fetch(new URL("/v1/syncs/active", webEnvironment.apiBaseUrl), {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal
        });
        if (!activeResponse.ok) throw new Error(await responseError(activeResponse, "Gmail sync status could not be loaded."));
        const activeParsed = GmailActiveSyncResponseSchema.safeParse(await activeResponse.json());
        if (!activeParsed.success) throw new Error("The Gmail sync response was invalid.");
        const activeSync = activeParsed.data.sync;
        if (activeSync && ["pending", "running", "partial"].includes(activeSync.status)) {
          setSyncProgress(activeSync);
        }
      }
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setConnectionError(error instanceof Error ? error.message : "Gmail connection status could not be loaded.");
      setConnectionState("error");
    });

    return () => {
      controller.abort();
      syncController.current?.abort();
    };
  }, []);

  const activeSyncId = syncProgress && ["pending", "running", "partial"].includes(syncProgress.status)
    ? syncProgress.syncId
    : null;
  const activeSyncStatus = syncProgress?.status ?? null;

  useEffect(() => {
    if (!activeSyncId) return;
    const controller = new AbortController();

    const poll = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(new URL(`/v1/syncs/${encodeURIComponent(activeSyncId)}`, webEnvironment.apiBaseUrl), {
            credentials: "include",
            cache: "no-store",
            signal: controller.signal
          });
          if (!response.ok) throw new Error(await responseError(response, "Gmail sync progress could not be loaded."));
          const parsed = GmailSyncResponseSchema.safeParse(await response.json());
          if (!parsed.success) throw new Error("The Gmail sync response was invalid.");
          const latest = parsed.data.sync;
          setSyncProgress(latest);
          setSyncState("syncing");

          if (latest.status === "completed") {
            setSyncState("idle");
            setNotice(`Sync complete. ${latest.processedCount} messages were saved${latest.failedCount ? `; ${latest.failedCount} could not be imported` : ""}.`);
            setConnection((current) => current ? { ...current, lastSuccessfulSyncAt: latest.completedAt ?? new Date().toISOString() } : current);
            window.dispatchEvent(new Event("mailpilot:emails-synced"));
            return;
          }
          if (latest.status === "failed" || latest.status === "resync_required" || latest.status === "cancelled") {
            setSyncState("error");
            setSyncError(latest.status === "resync_required"
              ? "Gmail needs authorization again. Reconnect the mailbox and start a new sync."
              : latest.safeErrorCode ? `The sync ended with error ${latest.safeErrorCode}.` : "The sync did not complete.");
            return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
        } catch (error: unknown) {
          if (controller.signal.aborted) return;
          setSyncError(error instanceof Error ? error.message : "Gmail sync progress could not be loaded.");
          setSyncState("error");
          return;
        }
      }
    };

    void poll();
    return () => controller.abort();
  }, [activeSyncId, activeSyncStatus, syncMonitorVersion]);

  const startOrContinueSync = async () => {
    if (canContinueSync && syncProgress) {
      setSyncState("syncing");
      setSyncMonitorVersion((version) => version + 1);
      return;
    }

    const csrfToken = getCsrfToken();
    if (!csrfToken) {
      setSyncError("Your session needs refreshing. Reload the page and try again.");
      setSyncState("error");
      return;
    }

    syncController.current?.abort();
    const controller = new AbortController();
    syncController.current = controller;
    setSyncError("");

    try {
      setSyncState("starting");
      const mode = connection?.lastSuccessfulSyncAt ? "incremental" : "initial";
      const response = await fetch(new URL("/v1/syncs", webEnvironment.apiBaseUrl), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(mode === "initial" ? { mode, maxMessages: 500 } : { mode }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(await responseError(response, "Gmail sync could not be started."));
      const parsed = GmailSyncResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The Gmail sync response was invalid.");
      setSyncProgress(parsed.data.sync);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setSyncError(error instanceof Error ? error.message : "Gmail sync could not be completed.");
      setSyncState("error");
    }
  };

  const connectUrl = new URL("/v1/gmail/connect", webEnvironment.apiBaseUrl);
  connectUrl.searchParams.set("returnTo", "/settings");
  const connected = connection?.status === "active";
  const isSyncing = syncState === "starting" || syncState === "syncing";
  const canContinueSync = syncProgress !== null
    && ["pending", "running", "partial"].includes(syncProgress.status);
  const progressPercent = syncProgress?.maxMessages
    ? Math.min(100, Math.round((syncProgress.processedCount / syncProgress.maxMessages) * 100))
    : null;

  return (
    <Card className="gmail-connection-card">
      <div className="feature-card__header">
        <div><p className="feature-eyebrow">Mailbox access</p><h2>Connect Gmail</h2><p>MailPilot imports messages only after you authorize read-only access.</p></div>
        <Badge dot tone={connected ? "green" : connectionState === "error" ? "red" : "neutral"}>
          {connectionState === "loading" ? "Checking" : connected ? "Connected" : connectionState === "error" ? "Unavailable" : "Not connected"}
        </Badge>
      </div>

      {connectionState === "loading" ? (
        <p className="gmail-connection-card__copy" role="status">Checking Gmail connection…</p>
      ) : connectionState === "error" ? (
        <p className="gmail-connection-card__error" role="alert">{connectionError}</p>
      ) : (
        <>
          {connection && <p className="gmail-connection-card__account">{connection.email}{connection.status === "reauth_required" ? " · Reauthorization needed" : connection.status === "disconnected" ? " · Disconnected" : ""}</p>}
          {notice && <p className="gmail-connection-card__notice" role="status">{notice}</p>}
          {syncError && <p className="gmail-connection-card__error" role="alert">{syncError}</p>}

          {isSyncing && syncProgress && (
            <div aria-live="polite" className="gmail-sync-progress" role="status">
              <div><span>{syncStatusLabel(syncProgress)}</span><span>{syncProgress.processedCount} processed{syncProgress.listedCount ? ` · ${syncProgress.listedCount} found` : ""}</span></div>
              {progressPercent !== null && <progress aria-label="Initial Gmail sync progress" max={100} value={progressPercent} />}
            </div>
          )}

          <div className="gmail-connection-card__actions">
            {connected ? (
              <Button disabled={isSyncing} onClick={() => { void startOrContinueSync(); }}>
                {isSyncing ? "Syncing…" : canContinueSync ? "Check sync progress" : connection.lastSuccessfulSyncAt ? "Sync latest emails" : "Sync inbox"}
              </Button>
            ) : (
              <a className="button button--primary button--md" href={connectUrl.toString()}>
                {connection?.status === "reauth_required" ? "Reconnect Google" : "Connect Gmail"}
              </a>
            )}
            {syncProgress?.status === "completed" && <a className="button button--secondary button--md" href="/">View synced emails</a>}
          </div>

          <p className="gmail-connection-card__copy">Initial sync imports up to 500 recent messages. You can run another sync later for new mail.</p>
          {!connected && (
            <details className="gmail-setup-help">
              <summary>Local Gmail OAuth setup</summary>
              <p>Enable the Gmail API, add this read-only scope under Google Auth Platform → Data Access, and configure a web OAuth client:</p>
              <code>https://www.googleapis.com/auth/gmail.readonly</code>
              <p>Authorized redirect URI:</p>
              <code>http://localhost:4000/v1/oauth/google/callback</code>
              <p>Set <code>GOOGLE_GMAIL_OAUTH_CLIENT_ID</code> and <code>GOOGLE_GMAIL_OAUTH_CLIENT_SECRET</code> in the repository <code>.env</code>, then restart the API. In Testing mode, add your Google account as a test user.</p>
            </details>
          )}
        </>
      )}
    </Card>
  );
}
