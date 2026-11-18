import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states";
import { Icon, type IconName } from "@/components/ui/icon";
import type { InboxSummary } from "@/lib/mail-utils";
import type { MailItem, MailPriority } from "@/lib/mock-mail";

function StatCard({
  icon,
  label,
  value,
  detail,
  tone
}: {
  icon: IconName;
  label: string;
  value: number;
  detail: string;
  tone: "teal" | "amber" | "blue";
}) {
  return (
    <Card className="stat-card">
      <div aria-hidden="true" className={`stat-card__icon stat-card__icon--${tone}`}><Icon name={icon} size={19} /></div>
      <div className="stat-card__content">
        <span className="stat-card__label">{label}</span>
        <strong className="stat-card__value">{value}</strong>
        <span className="stat-card__detail">{detail}</span>
      </div>
    </Card>
  );
}

const PRIORITY_ORDER: MailPriority[] = ["urgent", "high", "normal", "low"];

function PrioritySummary({ summary }: { summary: InboxSummary }) {
  return (
    <Card aria-labelledby="priority-summary-title" className="priority-summary-card">
      <div className="rail-card-heading">
        <span aria-hidden="true" className="rail-card-heading__icon rail-card-heading__icon--amber"><Icon name="alert" size={18} /></span>
        <div><h2 id="priority-summary-title">Priority at a glance</h2><span>Inbox messages by priority</span></div>
      </div>
      <div className="priority-summary-list">
        {PRIORITY_ORDER.map((priority) => (
          <div className={`priority-summary-row priority-summary-row--${priority}`} key={priority}>
            <span>{priority.charAt(0).toUpperCase() + priority.slice(1)}<strong>{summary.priorityCounts[priority]}</strong></span>
            <progress
              aria-label={`${priority.charAt(0).toUpperCase() + priority.slice(1)} priority messages`}
              aria-valuetext={`${summary.priorityCounts[priority]} messages`}
              max={Math.max(summary.total, 1)}
              value={summary.priorityCounts[priority]}
            />
          </div>
        ))}
      </div>
    </Card>
  );
}

function AttentionList({
  items,
  searchQuery,
  onClearSearch
}: {
  items: MailItem[];
  searchQuery: string;
  onClearSearch: () => void;
}) {
  if (items.length === 0) {
    const hasSearch = searchQuery.trim().length > 0;
    return (
      <EmptyState
        action={hasSearch ? <Button onClick={onClearSearch} variant="secondary">Clear search</Button> : undefined}
        description={hasSearch ? "Try another keyword or clear your search to see priority conversations." : "Nothing urgent is waiting in your inbox."}
        icon={hasSearch ? "search" : "check"}
        title={hasSearch ? "No priority messages match" : "You're all caught up"}
      />
    );
  }

  return (
    <ul aria-label="Priority inbox messages" className="attention-list">
      {items.slice(0, 5).map((item) => (
        <li className="attention-row" key={item.id}>
          <span aria-hidden="true" className={`sender-avatar sender-avatar--${item.avatarTone}`}>{item.initials}</span>
          <div className="attention-row__content">
            <div className="attention-row__title">
              <strong>{item.subject}</strong>
              <time dateTime={item.dateTime}>{item.timeLabel}</time>
            </div>
            <div className="attention-row__meta">
              <span>{item.sender}</span>
              <Badge tone={item.statusTone}>{item.status}</Badge>
              <Badge tone={item.categoryTone}>{item.category}</Badge>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function DashboardOverview({
  summary,
  attentionItems,
  upcomingTasks,
  searchQuery,
  onClearSearch,
  onViewInbox,
  onViewTasks
}: {
  summary: InboxSummary;
  attentionItems: MailItem[];
  upcomingTasks: MailItem[];
  searchQuery: string;
  onClearSearch: () => void;
  onViewInbox: () => void;
  onViewTasks: () => void;
}) {
  return (
    <>
      <div className="stats-grid stats-grid--dashboard">
        <StatCard detail="Across recent conversations" icon="inbox" label="Inbox messages" tone="teal" value={summary.total} />
        <StatCard detail="Unread conversations" icon="mail" label="Unread" tone="blue" value={summary.unread} />
        <StatCard detail="Urgent and high priority" icon="alert" label="High priority" tone="amber" value={summary.highPriority} />
        <StatCard detail="A reply is still needed" icon="approvals" label="Needs reply" tone="teal" value={summary.needsReply} />
      </div>

      <div className="dashboard-grid dashboard-grid--overview">
        <Card aria-labelledby="attention-title" className="attention-card">
          <div className="mail-card__header">
            <div>
              <div className="mail-card__title-row">
                <h2 id="attention-title">Needs your attention</h2>
                <Badge tone="neutral">{attentionItems.length}</Badge>
              </div>
              <p>Urgent, high-priority, and reply-needed messages.</p>
            </div>
            <Button aria-label="View all inbox messages" onClick={onViewInbox} variant="secondary">Open inbox</Button>
          </div>
          <AttentionList items={attentionItems} onClearSearch={onClearSearch} searchQuery={searchQuery} />
        </Card>

        <aside aria-label="Inbox summaries" className="dashboard-rail">
          <PrioritySummary summary={summary} />
          <Card aria-labelledby="upcoming-title" className="next-up-card">
            <div className="rail-card-heading">
              <span aria-hidden="true" className="rail-card-heading__icon rail-card-heading__icon--blue"><Icon name="clock" size={18} /></span>
              <div><h2 id="upcoming-title">Upcoming follow-ups</h2><span>From sample conversations</span></div>
            </div>
            {upcomingTasks.length === 0 ? (
              <p className="upcoming-empty">No follow-ups are due soon.</p>
            ) : (
              <ul className="next-up-list">
                {upcomingTasks.slice(0, 3).map((task) => (
                  <li key={task.id}>
                    <span aria-hidden="true" className={`next-up-list__marker next-up-list__marker--${task.priority === "urgent" ? "amber" : "blue"}`} />
                    <span><strong>{task.subject}</strong><small>{task.timeLabel} · {task.sender}</small></span>
                  </li>
                ))}
              </ul>
            )}
            <Button className="next-up-card__action" onClick={onViewTasks} variant="ghost">View tasks <Icon name="arrow" size={16} /></Button>
          </Card>
          <div className="privacy-card">
            <span aria-hidden="true" className="privacy-card__icon"><Icon name="approvals" size={18} /></span>
            <div><strong>Always your call</strong><p>MailPilot drafts and organizes. You decide what happens next.</p></div>
          </div>
        </aside>
      </div>
    </>
  );
}
