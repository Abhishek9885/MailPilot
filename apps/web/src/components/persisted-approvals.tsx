"use client";

import { useEffect, useState } from "react";
import {
  ActionProposalListResponseSchema,
  ActionProposalResponseSchema,
  GoogleCalendarConnectionResponseSchema,
  ServiceErrorSchema,
  type ActionProposal,
  type ActionProposalSnapshot
} from "@mailpilot/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState, LoadingRows } from "@/components/ui/states";
import { webEnvironment } from "@/lib/environment";
import { getCsrfToken } from "@/lib/csrf-token";

type PageState = "loading" | "ready" | "error";

async function responseError(response: Response, fallback: string): Promise<string> {
  if (response.status === 401) return "Your session expired. Sign in again to review proposals.";
  try {
    const parsed = ServiceErrorSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.error.message : fallback;
  } catch {
    return fallback;
  }
}

function statusTone(status: ActionProposal["status"]): "neutral" | "amber" | "green" | "red" | "blue" {
  switch (status) {
    case "pending": return "amber";
    case "approved":
    case "succeeded": return "green";
    case "executing": return "blue";
    case "reconciliation_required": return "amber";
    case "failed":
    case "rejected": return "red";
    default: return "neutral";
  }
}

function prettyStatus(status: ActionProposal["status"], isCalendarEvent = false): string {
  if (status === "executing") return isCalendarEvent ? "Creating approved event" : "Executing (mock)";
  if (status === "succeeded") return isCalendarEvent ? "Event created" : "Mock succeeded";
  if (status === "failed") return isCalendarEvent ? "Event creation failed" : "Mock failed";
  if (status === "reconciliation_required") return "Outcome needs checking";
  return status[0]?.toUpperCase() + status.slice(1);
}

function executionMessage(code: string | null): string | null {
  if (!code) return null;
  switch (code) {
    case "CALENDAR_EVENT_CONFLICT": return "Another Calendar event overlaps this time. Adjust the times and propose it again.";
    case "CALENDAR_REAUTH_REQUIRED": return "Reconnect Google Calendar in Settings, then create a fresh proposal.";
    case "CALENDAR_CONNECTION_REQUIRED": return "Connect Google Calendar and confirm event creation is enabled.";
    case "CALENDAR_CREATION_DISABLED": return "Calendar event creation is disabled in the API environment.";
    case "CALENDAR_OUTCOME_UNKNOWN": return "Google's response was uncertain. Check the outcome before any retry.";
    case "CALENDAR_PROVIDER_REJECTED": return "Google Calendar rejected the event request. Review the event and connection settings.";
    default: return code;
  }
}

function actionTitle(snapshot: ActionProposalSnapshot): string {
  switch (snapshot.actionType) {
    case "send_email": return snapshot.payload.subject;
    case "create_task": return snapshot.payload.title;
    case "schedule_follow_up": return "Schedule follow-up";
    case "create_calendar_event": return snapshot.payload.title;
  }
}

function actionKind(snapshot: ActionProposalSnapshot): string {
  return snapshot.actionType === "create_calendar_event" ? "Google Calendar event" : snapshot.actionType.replaceAll("_", " ");
}

function riskTone(risk: ActionProposalSnapshot["riskLevel"]): "green" | "amber" | "red" {
  return risk === "high" ? "red" : risk === "medium" ? "amber" : "green";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function ActionDetails({ snapshot }: { snapshot: ActionProposalSnapshot }) {
  switch (snapshot.actionType) {
    case "send_email":
      return (
        <div className="approval-action-details">
          <dl>
            <dt>To</dt><dd>{snapshot.payload.to.join(", ")}</dd>
            {snapshot.payload.cc.length > 0 && <><dt>CC</dt><dd>{snapshot.payload.cc.join(", ")}</dd></>}
            {snapshot.payload.bcc.length > 0 && <><dt>BCC</dt><dd>{snapshot.payload.bcc.join(", ")}</dd></>}
            <dt>Subject</dt><dd>{snapshot.payload.subject}</dd>
            {snapshot.payload.replyToEmailId && <><dt>Replying to email</dt><dd className="approval-action-details__id">{snapshot.payload.replyToEmailId}</dd></>}
          </dl>
          <section aria-label="Exact proposed email content" className="approval-action-details__content">
            <h3>Exact message content</h3>
            <pre>{snapshot.payload.bodyText}</pre>
          </section>
        </div>
      );
    case "create_task":
      return (
        <div className="approval-action-details">
          <dl>
            <dt>Task title</dt><dd>{snapshot.payload.title}</dd>
            <dt>Description</dt><dd>{snapshot.payload.description || "None"}</dd>
            <dt>Due</dt><dd>{snapshot.payload.dueAt ? formatDate(snapshot.payload.dueAt) : "No due date"}</dd>
            <dt>Source email</dt><dd className="approval-action-details__id">{snapshot.payload.sourceEmailId ?? "None"}</dd>
          </dl>
        </div>
      );
    case "schedule_follow_up":
      return (
        <div className="approval-action-details">
          <dl>
            <dt>Email</dt><dd className="approval-action-details__id">{snapshot.payload.emailId}</dd>
            <dt>Scheduled for</dt><dd>{formatDate(snapshot.payload.scheduledAt)}</dd>
          </dl>
        </div>
      );
    case "create_calendar_event":
      return (
        <div className="approval-action-details">
          <dl>
            <dt>Calendar</dt><dd>Primary calendar owned by the connected Google account</dd>
            <dt>Title</dt><dd>{snapshot.payload.title}</dd>
            <dt>Start</dt><dd>{snapshot.payload.startLocal} · {formatCalendarDate(snapshot.payload.startAt, snapshot.payload.timezone)}</dd>
            <dt>End</dt><dd>{snapshot.payload.endLocal} · {formatCalendarDate(snapshot.payload.endAt, snapshot.payload.timezone)}</dd>
            <dt>Time zone</dt><dd>{snapshot.payload.timezone}</dd>
            <dt>Location</dt><dd>{snapshot.payload.location ?? "None"}</dd>
            <dt>Attendees</dt><dd>None will be invited</dd>
            <dt>Source email</dt><dd className="approval-action-details__id">{snapshot.payload.sourceEmailId}</dd>
          </dl>
        </div>
      );
  }
}

function formatCalendarDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "full", timeStyle: "short", timeZone: timezone
  }).format(new Date(value));
}

export function PersistedApprovalsPage() {
  const [proposals, setProposals] = useState<ActionProposal[]>([]);
  const [pageState, setPageState] = useState<PageState>("loading");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState("");
  const [mutatingId, setMutatingId] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [calendarReady, setCalendarReady] = useState(false);
  const [calendarWriteEnabled, setCalendarWriteEnabled] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(new URL("/v1/actions/proposals", webEnvironment.apiBaseUrl), {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response, "Saved action proposals could not be loaded."));
      const parsed = ActionProposalListResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The action proposal response was invalid.");
      setError("");
      setProposals(parsed.data.proposals);
      setPageState("ready");
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "Saved action proposals could not be loaded.");
      setPageState("error");
    });
    return () => controller.abort();
  }, [loadAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(new URL("/v1/calendar/connection", webEnvironment.apiBaseUrl), {
      credentials: "include", cache: "no-store", signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) return;
      const parsed = GoogleCalendarConnectionResponseSchema.safeParse(await response.json());
      if (!parsed.success) return;
      setCalendarReady(parsed.data.connection?.status === "active");
      setCalendarWriteEnabled(parsed.data.eventCreationEnabled);
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);

  const decide = async (proposal: ActionProposal, action: "approve" | "reject" | "execute" | "reconcile") => {
    const csrfToken = getCsrfToken();
    if (!csrfToken) {
      setError("Your session needs refreshing. Reload the page and try again.");
      return;
    }
    setMutatingId(proposal.id);
    setError("");
    try {
      const response = await fetch(new URL(`/v1/actions/proposals/${encodeURIComponent(proposal.id)}/${action}`, webEnvironment.apiBaseUrl), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ payloadHash: proposal.payloadHash })
      });
      if (!response.ok) throw new Error(await responseError(response, "The action proposal could not be updated."));
      const parsed = ActionProposalResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The updated action proposal response was invalid.");
      setProposals((current) => current.map((item) => item.id === proposal.id ? parsed.data.proposal : item));
      setAnnouncement(action === "approve"
        ? "Exact proposal approved. Review it again before running the local mock."
        : action === "reject" ? "Proposal rejected."
          : action === "reconcile"
            ? parsed.data.proposal.status === "approved"
              ? "The mock confirms no action occurred. The approved proposal can be run again."
              : "The outcome is still unknown. Another run remains blocked."
            : "Local mock run completed. No external action was taken.");
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "The action proposal could not be updated.");
      if (caught instanceof Error && caught.message.toLowerCase().includes("proposal")) {
        setPageState("loading");
        setLoadAttempt((attempt) => attempt + 1);
      }
    } finally {
      setMutatingId("");
    }
  };

  const pendingCount = proposals.filter((proposal) => proposal.status === "pending").length;

  return (
    <div className="page-content-stack">
      <div aria-live="polite" className="visually-hidden">{announcement}</div>
      <div className="agent-status-banner approvals-preview-banner">
        <span aria-hidden="true" className="agent-status-banner__icon">!</span>
        <div><strong>Review the exact proposed action</strong><span>Approval binds to this saved payload and expires after 24 hours. Calendar events are created only after a separate approval and an explicit create action.</span></div>
        <Badge tone="amber">{pendingCount} pending</Badge>
      </div>

      {error && pageState === "ready" && <p className="approval-page-error" role="alert">{error}</p>}
      {pageState === "loading" ? (
        <Card className="approval-card"><LoadingRows label="Loading saved action proposals" rows={3} /></Card>
      ) : pageState === "error" ? (
        <ErrorState description={error} onRetry={() => { setError(""); setPageState("loading"); setLoadAttempt((attempt) => attempt + 1); }} title="Action proposals unavailable" />
      ) : proposals.length === 0 ? (
        <Card className="empty-work-page"><h2>No saved action proposals</h2><p>Proposals generated from completed workflows will appear here.</p></Card>
      ) : (
        <div aria-label="Persisted action proposals" className="approval-list">
          {proposals.map((proposal) => (
            <Card className="approval-card persisted-approval-card" key={proposal.id}>
              <div className="approval-card__heading">
                <span aria-hidden="true" className="approval-card__avatar">{proposal.snapshot.actionType === "send_email" ? "✉" : proposal.snapshot.actionType === "create_task" ? "✓" : proposal.snapshot.actionType === "create_calendar_event" ? "▦" : "◷"}</span>
                <div>
                  <p className="feature-eyebrow">{actionKind(proposal.snapshot)} · {proposal.snapshot.actionType === "send_email" ? proposal.snapshot.payload.to.join(", ") : "Destination details below"}</p>
                  <h2>{actionTitle(proposal.snapshot)}</h2>
                  <span>Created {formatDate(proposal.snapshot.createdAt)} · Expires {formatDate(proposal.snapshot.expiresAt)}</span>
                </div>
                <Badge tone={statusTone(proposal.status)}>{prettyStatus(proposal.status, proposal.snapshot.actionType === "create_calendar_event")}</Badge>
              </div>

              <div className="persisted-approval-card__badges">
                <Badge tone={riskTone(proposal.snapshot.riskLevel)}>{proposal.snapshot.riskLevel} risk</Badge>
                <span>Approved payload hash <code>{proposal.payloadHash.slice(0, 16)}…</code></span>
              </div>

              <ActionDetails snapshot={proposal.snapshot} />

              {proposal.execution.attempts > 0 && (
                <p className="approval-card__result">{proposal.snapshot.actionType === "create_calendar_event" ? "Calendar" : "Mock"} execution attempts: {proposal.execution.attempts}
                  {executionMessage(proposal.execution.resultCode) ? ` · ${executionMessage(proposal.execution.resultCode)}` : ""}
                </p>
              )}

              <section aria-label="Source evidence" className="approval-evidence">
                <h3>Source evidence</h3>
                {proposal.snapshot.sourceEvidence.map((evidence) => (
                  <div className="approval-evidence__item" key={`${evidence.emailId}:${evidence.sourceRevision}`}>
                    <p>Email <code>{evidence.emailId}</code> · Thread <code>{evidence.threadId}</code> · Revision {evidence.sourceRevision}</p>
                    <blockquote>{evidence.quote}</blockquote>
                  </div>
                ))}
              </section>

              {proposal.status === "pending" && (
                <div className="approval-card__actions">
                  <Button disabled={mutatingId === proposal.id} onClick={() => { void decide(proposal, "reject"); }} variant="secondary">Reject</Button>
                  <Button disabled={mutatingId === proposal.id} onClick={() => { void decide(proposal, "approve"); }}>
                    {mutatingId === proposal.id ? "Saving…" : "Approve exact proposal"}
                  </Button>
                </div>
              )}
              {proposal.status === "approved" && (
                <div className="approval-card__actions approval-card__actions--mock">
                  {proposal.snapshot.actionType === "create_calendar_event" ? <>
                    <p>{!calendarReady ? "Connect or reconnect Google Calendar in Settings before creating this approved event." : !calendarWriteEnabled ? "Calendar event creation is disabled in the API environment." : "This will create the exact approved event in your primary Google Calendar. No attendees will be invited."}</p>
                    <Button disabled={mutatingId === proposal.id || !calendarReady || !calendarWriteEnabled} onClick={() => { void decide(proposal, "execute"); }} variant="secondary">
                      {mutatingId === proposal.id ? "Creating approved event…" : "Create approved Calendar event"}
                    </Button>
                  </> : <>
                    <p>Local mock only. No email, task, or reminder will be sent or created in an external service.</p>
                    <Button disabled={mutatingId === proposal.id} onClick={() => { void decide(proposal, "execute"); }} variant="secondary">
                      {mutatingId === proposal.id ? "Running mock…" : "Run mock executor"}
                    </Button>
                  </>}
                </div>
              )}
              {proposal.status === "reconciliation_required" && (
                <div className="approval-card__actions approval-card__actions--mock">
                  <p>The previous run may have partially completed. Check its outcome before any retry; another run is allowed only after confirming no action occurred.</p>
                  <Button disabled={mutatingId === proposal.id} onClick={() => { void decide(proposal, "reconcile"); }} variant="secondary">
                    {mutatingId === proposal.id ? "Checking outcome…" : "Check outcome"}
                  </Button>
                </div>
              )}
              {proposal.status !== "pending" && proposal.status !== "approved" && (
                  <p className="approval-card__result" role="status">Proposal state: {prettyStatus(proposal.status, proposal.snapshot.actionType === "create_calendar_event")}. The approved snapshot has not changed.</p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
