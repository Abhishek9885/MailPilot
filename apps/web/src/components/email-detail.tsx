"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { ErrorState, LoadingRows } from "@/components/ui/states";
import { getMockEmailAnalysis, getMockThread, MOCK_ANALYSIS_ERROR_EMAIL_ID } from "@/lib/mock-email-details";
import { PRIORITY_TONES, type MailItem } from "@/lib/mock-mail";

type AnalysisState = "loading" | "ready" | "error";

function initialsFor(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

function AIWorkspace({ item }: { item: MailItem }) {
  const [state, setState] = useState<AnalysisState>("loading");
  const [attempt, setAttempt] = useState(0);
  const analysis = useMemo(() => getMockEmailAnalysis(item), [item]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setState(item.id === MOCK_ANALYSIS_ERROR_EMAIL_ID && attempt === 0 ? "error" : "ready");
    }, 520);

    return () => window.clearTimeout(timer);
  }, [attempt, item.id]);

  const retry = () => {
    setState("loading");
    setAttempt((current) => current + 1);
  };

  return (
    <Card aria-busy={state === "loading"} aria-labelledby="ai-workspace-title" className="ai-workspace-card">
      <div className="ai-workspace__header">
        <div>
          <p className="email-detail__eyebrow">AI workspace</p>
          <h2 id="ai-workspace-title">Thread insights</h2>
        </div>
        <Badge tone="blue">Mock suggestions</Badge>
      </div>

      {state === "loading" ? (
        <div className="ai-workspace__loading">
          <p className="ai-workspace__intro">Preparing the sample summary and suggested follow-ups…</p>
          <LoadingRows label="Loading AI workspace suggestions" rows={4} />
        </div>
      ) : state === "error" ? (
        <ErrorState
          description="This preview simulates an analysis error. Retry to load the saved mock suggestions. No AI service was called."
          onRetry={retry}
          title="Sample analysis unavailable"
        />
      ) : (
        <div className="ai-workspace__content">
          <section aria-labelledby="ai-summary-title" className="ai-insight-section">
            <h3 id="ai-summary-title">Summary <Badge tone="blue">Suggestion</Badge></h3>
            <p className="ai-summary-copy">{analysis.summary}</p>
          </section>

          <section aria-labelledby="ai-actions-title" className="ai-insight-section">
            <h3 id="ai-actions-title">Extracted action items</h3>
            <ul className="suggested-action-list">
              {analysis.actions.map((action) => (
                <li key={action.id}>
                  <span aria-hidden="true" className="suggested-action-list__marker"><Icon name="check" size={15} /></span>
                  <span className="suggested-action-list__copy">
                    <strong>{action.title}</strong>
                    <span>Suggested · Not assigned</span>
                  </span>
                  <a className="source-jump" href={`#${action.sourceMessageId}`}>Source</a>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="ai-deadline-title" className="ai-insight-section">
            <h3 id="ai-deadline-title">Deadlines to review</h3>
            <ul className="deadline-list">
              {analysis.actions.map((action) => (
                <li key={action.id}>
                  <span aria-hidden="true" className="deadline-list__icon"><Icon name="clock" size={15} /></span>
                  <span><strong>{action.deadline}</strong><small>Suggested from the message</small></span>
                  <a className="source-jump" href={`#${action.sourceMessageId}`}>Source</a>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="proposed-reply-title" className="ai-insight-section">
            <div className="ai-insight-section__heading">
              <h3 id="proposed-reply-title">Proposed reply</h3>
              <Badge tone="amber">Not sent</Badge>
            </div>
            <pre className="proposed-reply">{analysis.proposedReply}</pre>
            <p className="ai-workspace__microcopy">AI suggestion only. Review and edit before using it.</p>
          </section>

          <section aria-labelledby="source-references-title" className="ai-insight-section">
            <h3 id="source-references-title">Source references</h3>
            <ul className="source-reference-list">
              {analysis.sources.map((source) => (
                <li key={source.id}>
                  <a href={`#${source.messageId}`}>
                    <span><strong>{source.label}</strong><small>{source.excerpt}</small></span>
                    <Icon name="arrow" size={15} />
                  </a>
                </li>
              ))}
            </ul>
          </section>

          <div aria-label="Executed actions" className="executed-actions-note" role="group">
            <span aria-hidden="true"><Icon name="check" size={15} /></span>
            <p><strong>No actions executed</strong><small>No message was sent, task assigned, or deadline changed.</small></p>
          </div>
          <p className="ai-workspace__disclosure">Sample content · No AI provider connected</p>
        </div>
      )}
    </Card>
  );
}

export function EmailDetail({ item }: { item: MailItem }) {
  const messages = useMemo(() => getMockThread(item), [item]);

  return (
    <div className="email-detail-grid">
      <section aria-labelledby="thread-title" className="thread-column">
        <Card className="thread-card">
          <div className="thread-card__header">
            <div>
              <p className="email-detail__eyebrow">Conversation</p>
              <h2 id="thread-title">Message timeline</h2>
              <p>{messages.length} {messages.length === 1 ? "message" : "messages"} · Latest from {item.sender}</p>
            </div>
            <div aria-label="Thread labels" className="thread-labels">
              <Badge tone={item.categoryTone}>{item.category}</Badge>
              <Badge tone={PRIORITY_TONES[item.priority]}>{item.priority} priority</Badge>
              <Badge tone={item.statusTone}>{item.status}</Badge>
            </div>
          </div>

          <ol aria-label="Messages in this conversation" className="thread-timeline">
            {messages.map((message) => (
              <li className={`thread-message thread-message--${message.direction}`} id={message.id} key={message.id}>
                <span aria-hidden="true" className={`thread-message__avatar ${message.direction === "outgoing" ? "thread-message__avatar--self" : ""}`}>
                  {initialsFor(message.sender)}
                </span>
                <article className="thread-message__body">
                  <header className="thread-message__header">
                    <div><strong>{message.sender}</strong><span>{message.address}</span></div>
                    <time dateTime={message.dateTime}>{message.timeLabel}</time>
                  </header>
                  <p>{message.body}</p>
                  {message.direction === "outgoing" && <span className="thread-message__direction">Sent message</span>}
                </article>
              </li>
            ))}
          </ol>
          <div className="thread-card__footer">
            <span>Mock conversation timeline</span>
            <span className="mock-data-note"><span aria-hidden="true" className="mock-data-note__dot" />Sample data only</span>
          </div>
        </Card>
      </section>

      <aside aria-label="AI workspace" className="ai-workspace-column">
        <AIWorkspace item={item} key={item.id} />
      </aside>
    </div>
  );
}
