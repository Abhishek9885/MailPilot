"use client";

import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { TextField, SelectField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { GmailConnectionPanel } from "@/components/gmail-connection-panel";
import { CalendarConnectionPanel } from "@/components/calendar-connection-panel";
import { MemoryManagementPanel } from "@/components/memory-management-panel";
import { MOCK_MAIL } from "@/lib/mock-mail";

export function AgentPage({ onViewApprovals, onViewTasks }: { onViewApprovals: () => void; onViewTasks: () => void }) {
  const suggestions = [
    { title: "Prepare a reply about Q3 launch dates", detail: "Jordan Lee · Project · Needs your approval", tone: "amber" as const },
    { title: "Review the vendor agreement language", detail: "Priya Nair · Legal · Source message available", tone: "blue" as const },
    { title: "Follow up on the incident mitigation plan", detail: "Marcus Reed · Operations · Due today", tone: "red" as const }
  ];

  return (
    <div className="page-content-stack">
      <div className="agent-status-banner">
        <span aria-hidden="true" className="agent-status-banner__icon"><Icon name="sparkles" size={18} /></span>
        <div><strong>Agent is idle in this preview</strong><span>These are saved mock suggestions. No agent run or email action has occurred.</span></div>
        <Badge tone="neutral">No live agent</Badge>
      </div>

      <div className="stats-grid agent-stats-grid">
        <Card className="inbox-count-card"><span>Suggested for review</span><strong>3</strong></Card>
        <Card className="inbox-count-card"><span>Pending approvals</span><strong>{MOCK_MAIL.filter((item) => item.view === "approvals").length}</strong></Card>
        <Card className="inbox-count-card"><span>Open follow-ups</span><strong>{MOCK_MAIL.filter((item) => item.view === "tasks" && item.status !== "Complete").length}</strong></Card>
      </div>

      <div className="agent-grid">
        <Card aria-labelledby="agent-suggestions-title" className="agent-suggestions-card">
          <div className="feature-card__header">
            <div><p className="feature-eyebrow">Review queue</p><h2 id="agent-suggestions-title">Suggestions for you</h2><p>Potential next steps based on sample conversations.</p></div>
            <Badge tone="teal">Suggestions only</Badge>
          </div>
          <ul className="agent-suggestion-list">
            {suggestions.map((suggestion) => (
              <li key={suggestion.title}>
                <span aria-hidden="true" className={`agent-suggestion-list__marker agent-suggestion-list__marker--${suggestion.tone}`}><Icon name="sparkles" size={15} /></span>
                <span><strong>{suggestion.title}</strong><small>{suggestion.detail}</small></span>
                <Badge tone={suggestion.tone}>Suggested</Badge>
              </li>
            ))}
          </ul>
          <div className="feature-card__actions">
            <Button onClick={onViewApprovals} variant="secondary">Review approvals</Button>
            <Button onClick={onViewTasks} variant="ghost">Open tasks <Icon name="arrow" size={15} /></Button>
          </div>
        </Card>

        <Card aria-labelledby="agent-controls-title" className="agent-controls-card">
          <div className="feature-card__header"><div><p className="feature-eyebrow">Run controls</p><h2 id="agent-controls-title">Nothing runs automatically</h2></div></div>
          <p className="agent-controls-copy">MailPilot keeps proposed replies and follow-ups in a review state. A future live run would require an approved, exact action before anything is sent or changed.</p>
          <div className="agent-control-state"><span aria-hidden="true"><Icon name="approvals" size={17} /></span><div><strong>Execution disabled</strong><small>No Gmail or AI provider is connected.</small></div></div>
        </Card>
      </div>
    </div>
  );
}

export { PersistedApprovalsPage as ApprovalsPage } from "@/components/persisted-approvals";

export { TasksPage } from "@/components/task-management";

interface ActivityEntry {
  id: string;
  dateTime: string;
  timeLabel: string;
  title: string;
  description: string;
  actor: string;
  tone: "teal" | "blue" | "amber" | "neutral";
  emailId?: string;
}

const ACTIVITY_HISTORY: ActivityEntry[] = [
  { id: "activity-1", dateTime: "2026-10-27T10:06:00+05:30", timeLabel: "Today, 10:06 AM", title: "Reply suggestion prepared", description: "A draft about Q3 launch dates was added to the review queue. It was not sent.", actor: "MailPilot · Suggestion", tone: "teal", emailId: "approval-1" },
  { id: "activity-2", dateTime: "2026-10-27T09:42:00+05:30", timeLabel: "Today, 9:42 AM", title: "Brand review conversation updated", description: "A new message from Olivia Chen mentions feedback due tomorrow at noon.", actor: "Inbox · Sample event", tone: "blue", emailId: "mail-1" },
  { id: "activity-3", dateTime: "2026-10-27T08:54:00+05:30", timeLabel: "Today, 8:54 AM", title: "Vendor agreement flagged for review", description: "The latest message was categorized as Legal and marked high priority.", actor: "MailPilot · Suggestion", tone: "amber", emailId: "mail-3" },
  { id: "activity-4", dateTime: "2026-10-26T17:05:00+05:30", timeLabel: "Yesterday, 5:05 PM", title: "Incident follow-up added", description: "A sample task was created from the production handoff conversation.", actor: "Tasks · Sample event", tone: "neutral", emailId: "mail-6" }
];

export function ActivityPage({ onOpenEmail }: { onOpenEmail: (id: string) => void }) {
  return (
    <Card aria-labelledby="activity-history-title" className="activity-card">
      <div className="task-board__header"><div><p className="feature-eyebrow">Recent history</p><h2 id="activity-history-title">Activity</h2><p>Mock events from the MailPilot preview workspace.</p></div><Badge tone="neutral">Sample history</Badge></div>
      <ol aria-label="Recent workspace activity" className="activity-list">
        {ACTIVITY_HISTORY.map((entry) => (
          <li key={entry.id}>
            <span aria-hidden="true" className={`activity-list__marker activity-list__marker--${entry.tone}`}><Icon name="clock" size={14} /></span>
            <div className="activity-list__content"><div><h3>{entry.title}</h3><time dateTime={entry.dateTime}>{entry.timeLabel}</time></div><p>{entry.description}</p><span className="activity-list__actor">{entry.actor}</span></div>
            {entry.emailId && <Button onClick={() => onOpenEmail(entry.emailId!)} size="sm" variant="ghost">View source</Button>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function SettingsPage() {
  const [saved, setSaved] = useState(false);

  const saveSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(true);
  };

  return (
    <div className="settings-layout">
      <Card className="settings-card">
        <div className="feature-card__header"><div><p className="feature-eyebrow">Your workspace</p><h2>Profile</h2><p>These values are only shown in this local preview.</p></div></div>
        <form className="settings-form" onSubmit={saveSettings} onChange={() => setSaved(false)}>
          <TextField autoComplete="name" defaultValue="Alex Morgan" id="settings-name" label="Display name" required />
          <TextField autoComplete="email" defaultValue="alex@acmestudio.example" id="settings-email" label="Email address" required type="email" />
          <SelectField defaultValue="Asia/Kolkata" id="settings-timezone" label="Time zone">
            <option value="Asia/Kolkata">Asia/Kolkata (UTC+05:30)</option>
            <option value="America/New_York">America/New_York</option>
            <option value="Europe/London">Europe/London</option>
          </SelectField>
          <fieldset className="settings-fieldset">
            <legend>Email preferences</legend>
            <label className="settings-checkbox"><input defaultChecked name="daily-summary" type="checkbox" /><span><strong>Daily summary</strong><small>Show a summary of priority conversations in the dashboard.</small></span></label>
            <label className="settings-checkbox"><input defaultChecked name="approval-notices" type="checkbox" /><span><strong>Approval reminders</strong><small>Show a reminder when a draft is waiting for review.</small></span></label>
          </fieldset>
          <div className="settings-form__footer">
            <Button type="submit">Save preview settings</Button>
            <p aria-live="polite" role={saved ? "status" : undefined}>{saved ? "Saved in this preview. Settings were not synced." : "Settings stay on this screen and are not synced."}</p>
          </div>
        </form>
      </Card>
      <GmailConnectionPanel />
      <CalendarConnectionPanel />
      <MemoryManagementPanel />
    </div>
  );
}
