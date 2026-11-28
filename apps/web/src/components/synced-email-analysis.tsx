"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CalendarEventProposal } from "@/components/calendar-event-proposal";
import {
  EmailAnalysisReadResponseSchema,
  ServiceErrorSchema,
  StoredEmailAnalysisSchema,
  SyncedEmailListResponseSchema,
  type StoredEmailAnalysis,
  type SyncedEmailSummary
} from "@mailpilot/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SelectField } from "@/components/ui/field";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { webEnvironment } from "@/lib/environment";
import { getCsrfToken } from "@/lib/csrf-token";

type AnalysisState = "loading" | "ready" | "load-error" | "generating" | "generation-error";

async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
  if (response.status === 401) return "Your session has expired. Sign in again to continue.";
  try {
    const payload: unknown = await response.json();
    const parsed = ServiceErrorSchema.safeParse(payload);
    return parsed.success ? parsed.data.error.message : fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function AnalysisResults({ analysis, email }: { analysis: StoredEmailAnalysis; email: SyncedEmailSummary }) {
  const { analysis: result } = analysis;
  return (
    <div className="ai-workspace__content">
      <section className="ai-insight-section" aria-labelledby="synced-analysis-summary">
        <h3 id="synced-analysis-summary">Summary <Badge tone="blue">Suggestion</Badge></h3>
        <p className="ai-summary-copy">{result.summary}</p>
        <div className="synced-analysis__badges">
          {result.categories.map((category) => <Badge key={category} tone="teal">{category}</Badge>)}
          <Badge tone={result.priority === "urgent" ? "red" : result.priority === "high" ? "amber" : "blue"}>
            {result.priority} priority
          </Badge>
        </div>
      </section>

      {result.actionItems.length > 0 && (
        <section className="ai-insight-section" aria-labelledby="synced-analysis-actions">
          <h3 id="synced-analysis-actions">Action items</h3>
          <ul className="synced-analysis__list">
            {result.actionItems.map((item, index) => (
              <li key={`${item.task}-${index}`}>
                <strong>{item.task}</strong>
                <span>Owner: {item.owner}{item.dueDate ? ` · Due ${item.dueDate}` : " · No date stated"}</span>
                <blockquote>{item.evidence}</blockquote>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.deadlines.length > 0 && (
        <section className="ai-insight-section" aria-labelledby="synced-analysis-deadlines">
          <h3 id="synced-analysis-deadlines">Deadline candidates</h3>
          <ul className="synced-analysis__list">
            {result.deadlines.map((deadline, index) => (
              <li key={`${deadline.sourceText}-${index}`}>
                <strong>{deadline.sourceText} · {deadline.candidateDate ?? "Date unclear"}</strong>
                <span>{Math.round(deadline.confidence * 100)}% confidence</span>
                <blockquote>{deadline.evidence}</blockquote>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.commitments.length > 0 && (
        <section className="ai-insight-section" aria-labelledby="synced-analysis-commitments">
          <h3 id="synced-analysis-commitments">Commitments</h3>
          <ul className="synced-analysis__list">
            {result.commitments.map((commitment, index) => (
              <li key={`${commitment.commitment}-${index}`}>
                <strong>{commitment.commitment}</strong>
                <span>{commitment.speaker}{commitment.dueDate ? ` · ${commitment.dueDate}` : ""}</span>
                <blockquote>{commitment.evidence}</blockquote>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.eventCandidates.length > 0 && (
        <section className="ai-insight-section" aria-labelledby="synced-analysis-events">
          <h3 id="synced-analysis-events">Event candidates</h3>
          <ul className="synced-analysis__list">
            {result.eventCandidates.map((event, index) => (
              <CalendarEventProposal email={email} event={event} key={`${event.title}-${index}`} />
            ))}
          </ul>
        </section>
      )}

      <p className="ai-workspace__disclosure">Model {analysis.modelVersion} · Saved {formatDate(analysis.createdAt)}</p>
    </div>
  );
}

export function SyncedEmailAnalysis({
  searchQuery = "",
  onClearSearch
}: {
  searchQuery?: string;
  onClearSearch?: () => void;
}) {
  const [emails, setEmails] = useState<SyncedEmailSummary[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [listError, setListError] = useState("");
  const [listAttempt, setListAttempt] = useState(0);
  const [selectedEmailId, setSelectedEmailId] = useState("");
  const [analysis, setAnalysis] = useState<StoredEmailAnalysis | null>(null);
  const [analysisState, setAnalysisState] = useState<AnalysisState>("loading");
  const [analysisError, setAnalysisError] = useState("");
  const [analysisAttempt, setAnalysisAttempt] = useState(0);
  const requestVersion = useRef(0);
  const analysisController = useRef<AbortController | null>(null);

  useEffect(() => () => analysisController.current?.abort(), []);

  useEffect(() => {
    const refreshEmails = () => {
      setListError("");
      setListState("loading");
      setListAttempt((attempt) => attempt + 1);
    };
    window.addEventListener("mailpilot:emails-synced", refreshEmails);
    return () => window.removeEventListener("mailpilot:emails-synced", refreshEmails);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const emailListUrl = new URL("/v1/emails?limit=50", webEnvironment.apiBaseUrl);
    const requestedEmailId = new URLSearchParams(window.location.search).get("emailId");
    if (requestedEmailId) emailListUrl.searchParams.set("emailId", requestedEmailId);
    void fetch(emailListUrl, {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) throw new Error(await apiErrorMessage(response, "Synced emails could not be loaded."));
      const parsed = SyncedEmailListResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The email list response was invalid.");
      setEmails(parsed.data.emails);
      if (requestedEmailId && parsed.data.emails.some((email) => email.id === requestedEmailId)) {
        setSelectedEmailId(requestedEmailId);
        const currentUrl = new URL(window.location.href);
        currentUrl.searchParams.delete("emailId");
        window.history.replaceState(null, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
      }
      setListState("ready");
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setListError(error instanceof Error ? error.message : "Synced emails could not be loaded.");
      setListState("error");
    });
    return () => controller.abort();
  }, [listAttempt]);

  const selectedEmail = selectedEmailId
    ? emails.find((email) => email.id === selectedEmailId) ?? null
    : emails[0] ?? null;
  const selectedEmailIdForAnalysis = selectedEmail?.id ?? null;
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const visibleEmails = useMemo(() => emails.filter((email) => {
    if (!normalizedSearch) return true;
    return [email.subject, email.senderName, email.senderEmail, ...email.labels]
      .filter((value): value is string => value !== null)
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedSearch);
  }), [emails, normalizedSearch]);
  useEffect(() => {
    if (!selectedEmailIdForAnalysis) return;
    const controller = new AbortController();
    const version = ++requestVersion.current;
    void fetch(new URL(`/v1/emails/${encodeURIComponent(selectedEmailIdForAnalysis)}/analysis`, webEnvironment.apiBaseUrl), {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) throw new Error(await apiErrorMessage(response, "Saved analysis could not be loaded."));
      const parsed = EmailAnalysisReadResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The saved analysis response was invalid.");
      if (version !== requestVersion.current) return;
      setAnalysis(parsed.data.analysis);
      setAnalysisState("ready");
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (version !== requestVersion.current) return;
      setAnalysisError(error instanceof Error ? error.message : "Saved analysis could not be loaded.");
      setAnalysisState("load-error");
    });
    return () => controller.abort();
  }, [analysisAttempt, selectedEmailIdForAnalysis]);

  const runAnalysis = async () => {
    const emailId = selectedEmailIdForAnalysis;
    if (!emailId) return;
    const csrfToken = getCsrfToken();
    if (!csrfToken) {
      setAnalysisError("Your session needs refreshing. Reload the page and try again.");
      setAnalysisState("generation-error");
      return;
    }
    analysisController.current?.abort();
    const controller = new AbortController();
    analysisController.current = controller;
    const version = ++requestVersion.current;
    setAnalysisState("generating");
    setAnalysisError("");
    try {
      const response = await fetch(new URL(`/v1/emails/${encodeURIComponent(emailId)}/analysis`, webEnvironment.apiBaseUrl), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ reanalyze: analysis !== null }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, "Analysis could not be completed."));
      const payload: unknown = await response.json();
      const parsed = StoredEmailAnalysisSchema.safeParse(
        typeof payload === "object" && payload !== null && "analysis" in payload
          ? payload.analysis
          : undefined
      );
      if (!parsed.success) throw new Error("The analysis response was invalid.");
      if (version !== requestVersion.current) return;
      setAnalysis(parsed.data);
      setAnalysisState("ready");
    } catch (error: unknown) {
      if (controller.signal.aborted || version !== requestVersion.current) return;
      setAnalysisError(error instanceof Error ? error.message : "Analysis could not be completed.");
      setAnalysisState("generation-error");
    }
  };

  const selectEmail = (emailId: string) => {
    requestVersion.current += 1;
    analysisController.current?.abort();
    setAnalysis(null);
    setAnalysisState("loading");
    setAnalysisError("");
    setSelectedEmailId(emailId);
  };

  return (
    <div aria-busy={listState === "loading" || analysisState === "loading" || analysisState === "generating"}
      className="synced-mailbox">
      <Card aria-labelledby="synced-inbox-title" className="mail-card inbox-card synced-inbox-card">
        <div className="mail-card__header">
          <div>
            <div className="mail-card__title-row">
              <h2 id="synced-inbox-title">Synced emails</h2>
              {listState === "ready" && (
                <Badge tone="neutral">
                  {normalizedSearch ? `${visibleEmails.length} / ${emails.length}` : emails.length}
                </Badge>
              )}
            </div>
            <p>{normalizedSearch
              ? `Matching synced messages for “${searchQuery.trim()}”.`
              : "Messages imported from your connected Gmail account."}</p>
          </div>
          <Button
            disabled={listState === "loading"}
            onClick={() => {
              setListError("");
              setListState("loading");
              setListAttempt((attempt) => attempt + 1);
            }}
            variant="secondary"
          >
            Refresh
          </Button>
        </div>

        {listState === "loading" ? (
          <div className="ai-workspace__loading"><LoadingRows label="Loading synced emails" rows={4} /></div>
        ) : listState === "error" ? (
          <ErrorState
            description={listError}
            onRetry={() => {
              setListError("");
              setListState("loading");
              setListAttempt((attempt) => attempt + 1);
            }}
            title="Synced emails unavailable"
          />
        ) : emails.length === 0 ? (
          <EmptyState
            action={<Link className="button button--primary button--md" href="/settings">Connect Gmail in settings</Link>}
            description="Connect Gmail and run a sync. Demo conversations are kept separate from your mailbox."
            icon="mail"
            title="No synced emails yet"
          />
        ) : visibleEmails.length === 0 ? (
          <EmptyState
            action={onClearSearch
              ? <Button onClick={onClearSearch} variant="secondary">Clear search</Button>
              : undefined}
            description="Try another sender, subject, or keyword."
            icon="search"
            title="No matching synced emails"
          />
        ) : (
          <ul className="synced-inbox-list">
            {visibleEmails.map((email) => (
              <li key={email.id}>
                <button
                  aria-pressed={selectedEmail?.id === email.id}
                  className={selectedEmail?.id === email.id
                    ? "synced-inbox-list__button synced-inbox-list__button--selected"
                    : "synced-inbox-list__button"}
                  onClick={() => selectEmail(email.id)}
                  type="button"
                >
                  <span className="synced-inbox-list__copy">
                    <strong>{email.subject || "(No subject)"}</strong>
                    <span>{email.senderName || email.senderEmail || "Unknown sender"}</span>
                  </span>
                  <span className="synced-inbox-list__meta">
                    <time dateTime={email.receivedAt}>{formatDate(email.receivedAt)}</time>
                    <span>{selectedEmail?.id === email.id ? "Selected" : "Select to analyze"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {emails.length > 0 && selectedEmail && (
        <Card aria-labelledby="synced-email-analysis-title" className="ai-workspace-card synced-analysis-card">
          <div className="ai-workspace__header">
            <div>
              <p className="email-detail__eyebrow">Connected mailbox</p>
              <h2 id="synced-email-analysis-title">Email analysis</h2>
            </div>
            <Badge tone="blue">Review suggestions</Badge>
          </div>

          <div className="synced-analysis__selector">
            <SelectField
              id="synced-email-selector"
              label="Email to analyze"
              onChange={(event) => selectEmail(event.currentTarget.value)}
              value={selectedEmail.id}
            >
              {emails.map((email) => (
                <option key={email.id} value={email.id}>
                  {email.subject || "(No subject)"} · {email.senderName || email.senderEmail || "Unknown sender"}
                </option>
              ))}
            </SelectField>
            <p>{selectedEmail.senderEmail ?? "Unknown sender"} · {formatDate(selectedEmail.receivedAt)}</p>
          </div>

          {analysisState === "loading" ? (
            <div className="ai-workspace__loading">
              <p className="ai-workspace__intro">Loading saved analysis…</p>
              <LoadingRows label="Loading saved email analysis" rows={4} />
            </div>
          ) : analysisState === "load-error" ? (
            <ErrorState
              description={analysisError}
              onRetry={() => {
                setAnalysisError("");
                setAnalysisState("loading");
                setAnalysisAttempt((attempt) => attempt + 1);
              }}
              title="Saved analysis unavailable"
            />
          ) : analysisState === "generating" ? (
            <div className="ai-workspace__loading">
              <p className="ai-workspace__intro">{analysis ? "Re-analyzing this email…" : "Analyzing this email…"}</p>
              <LoadingRows label="Analyzing email" rows={4} />
              {analysis && <AnalysisResults analysis={analysis} email={selectedEmail} />}
              {analysis && <p className="ai-workspace__microcopy">The saved result remains available until this run completes.</p>}
            </div>
          ) : (
            <div className="ai-workspace__content">
              {analysisState === "generation-error" && (
                <ErrorState
                  description={`${analysisError}${analysis ? " The previous saved result is still shown below." : ""}`}
                  {...(analysis ? {} : { onRetry: () => { void runAnalysis(); } })}
                  title="Analysis failed"
                />
              )}
              {!analysis && analysisState !== "generation-error" && (
                <EmptyState
                  action={<Button onClick={() => { void runAnalysis(); }}>Analyze email</Button>}
                  description="Generate categories, priority, action items, deadline candidates, commitments, and event candidates from this stored email."
                  icon="sparkles"
                  title="No analysis saved"
                />
              )}
              {analysis && (
                <>
                  <div className="synced-analysis__toolbar">
                    <p className="ai-workspace__microcopy">Saved output is a suggestion. Re-analysis replaces the current result.</p>
                    <Button onClick={() => { void runAnalysis(); }} variant="secondary">
                      {analysisState === "generation-error" ? "Retry analysis" : "Re-analyze"}
                    </Button>
                  </div>
                  <AnalysisResults analysis={analysis} email={selectedEmail} />
                </>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
