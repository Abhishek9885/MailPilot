"use client";

import { useMemo, useReducer, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { TextField, SelectField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { approvalReducer, type ApprovalDecision } from "@/lib/approval-state";
import { MOCK_MAIL, PRIORITY_TONES } from "@/lib/mock-mail";
import { filterTasks, type TaskFilter } from "@/lib/workspace-page-utils";

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

const approvalReplies: Record<string, string> = {
  "approval-1": "Hi Jordan, Thursday, October 29 works for the customer announcement. I’ll confirm the final timing with the team.",
  "approval-2": "Hi Priya, thanks for the updated language. I’ve reviewed the revised agreement and it looks ready for the next review step.",
  "approval-3": "Hi Elena, thanks for sending the revised estimate. I’ll review the delivery details and follow up with any questions."
};

export function ApprovalsPage() {
  const [decisions, dispatch] = useReducer(approvalReducer, {});
  const [announcement, setAnnouncement] = useState("");
  const approvals = MOCK_MAIL.filter((item) => item.view === "approvals");
  const pendingCount = approvals.filter((item) => !decisions[item.id]).length;

  const decide = (id: string, decision: ApprovalDecision) => {
    dispatch({ type: "decide", id, decision });
    setAnnouncement(decision === "approved" ? "Suggestion approved in this preview. No email was sent." : "Suggestion rejected in this preview. No email was sent.");
  };

  return (
    <div className="page-content-stack">
      <div aria-live="polite" className="visually-hidden">{announcement}</div>
      <div className="agent-status-banner approvals-preview-banner">
        <span aria-hidden="true" className="agent-status-banner__icon"><Icon name="approvals" size={18} /></span>
        <div><strong>Review before anything happens</strong><span>Approve or reject only changes this local preview. It does not send a message.</span></div>
        <Badge tone="amber">{pendingCount} pending</Badge>
      </div>

      {approvals.length === 0 ? (
        <Card className="empty-work-page"><h2>Nothing needs your approval</h2><p>New suggestions will appear here for your review.</p></Card>
      ) : (
        <div aria-label="Reply suggestions awaiting review" className="approval-list">
          {approvals.map((item) => {
            const decision = decisions[item.id];
            return (
              <Card className="approval-card" key={item.id}>
                <div className="approval-card__heading">
                  <span aria-hidden="true" className="approval-card__avatar">{item.initials}</span>
                  <div><p className="feature-eyebrow">Proposed reply · {item.address}</p><h2>{item.subject}</h2><span>{item.timeLabel}</span></div>
                  {decision ? <Badge tone={decision === "approved" ? "green" : "neutral"}>{decision === "approved" ? "Approved in preview" : "Rejected in preview"}</Badge> : <Badge tone={PRIORITY_TONES[item.priority]}>Awaiting review</Badge>}
                </div>
                <p className="approval-card__context">{item.preview}</p>
                <div className="approval-draft">
                  <span>Suggested reply <Badge tone="blue">AI suggestion</Badge></span>
                  <p>{approvalReplies[item.id] ?? "Thanks for the update. I’ll review this and follow up shortly."}</p>
                </div>
                {decision ? (
                  <p className="approval-card__result" role="status">
                    {decision === "approved" ? "Approved in this preview. No message was sent." : "Rejected in this preview. No message was sent."}
                  </p>
                ) : (
                  <div className="approval-card__actions">
                    <Button onClick={() => decide(item.id, "rejected")} variant="secondary">Reject suggestion</Button>
                    <Button onClick={() => decide(item.id, "approved")}><Icon name="check" size={16} /> Approve in preview</Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

const TASK_FILTER_OPTIONS: { key: TaskFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "Overdue", label: "Overdue" },
  { key: "Due today", label: "Due today" },
  { key: "Due tomorrow", label: "Due tomorrow" },
  { key: "Complete", label: "Complete" }
];

export function TasksPage({ onOpenEmail }: { onOpenEmail: (id: string) => void }) {
  const [filter, setFilter] = useState<TaskFilter>("all");
  const tasks = useMemo(() => MOCK_MAIL.filter((item) => item.view === "tasks"), []);
  const visibleTasks = useMemo(() => filterTasks(tasks, filter), [filter, tasks]);

  return (
    <div className="page-content-stack">
      <Card className="task-board-card">
        <div className="task-board__header">
          <div><p className="feature-eyebrow">Follow-up board</p><h2>Tasks from conversations</h2><p>Deadlines and status are sample data. Nothing is scheduled or assigned.</p></div>
          <Badge tone="neutral">{visibleTasks.length} shown</Badge>
        </div>
        <div aria-label="Filter tasks by status" className="task-filters" role="group">
          {TASK_FILTER_OPTIONS.map((option) => (
            <button
              aria-pressed={filter === option.key}
              className={filter === option.key ? "filter-chip filter-chip--active" : "filter-chip"}
              key={option.key}
              onClick={() => setFilter(option.key)}
              type="button"
            >{option.label}</button>
          ))}
        </div>
        {visibleTasks.length > 0 ? (
          <ul className="task-list">
            {visibleTasks.map((task) => (
              <li key={task.id}>
                <span aria-hidden="true" className={`task-list__marker task-list__marker--${task.status === "Overdue" ? "overdue" : task.status === "Complete" ? "complete" : "open"}`}><Icon name={task.status === "Complete" ? "check" : "clock"} size={16} /></span>
                <div className="task-list__main"><div className="task-list__title"><h3>{task.subject}</h3><Badge tone={task.statusTone}>{task.status}</Badge></div><p>{task.preview}</p><span>{task.sender} · {task.category}</span></div>
                <div className="task-list__side"><time dateTime={task.dateTime}>{task.timeLabel}</time><Button onClick={() => onOpenEmail(task.id)} size="sm" variant="ghost">View source</Button></div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="task-empty" role="status"><span>No tasks match this filter.</span><Button onClick={() => setFilter("all")} variant="secondary">Show all tasks</Button></div>
        )}
      </Card>
    </div>
  );
}

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
      <Card className="settings-note-card"><span aria-hidden="true"><Icon name="approvals" size={18} /></span><div><h2>Connected services</h2><p>No email account or AI provider is connected. Saving these preview settings does not change external services.</p><Badge tone="neutral">Local preview</Badge></div></Card>
    </div>
  );
}
