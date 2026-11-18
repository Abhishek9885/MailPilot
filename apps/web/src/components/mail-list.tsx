import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type TableColumn } from "@/components/ui/table";
import { Icon } from "@/components/ui/icon";
import { PRIORITY_TONES, type MailItem } from "@/lib/mock-mail";

export function MailTable({
  items,
  starredIds,
  onToggleStar,
  onOpenEmail,
  caption,
  timeHeading
}: {
  items: MailItem[];
  starredIds: string[];
  onToggleStar: (id: string) => void;
  onOpenEmail: (id: string) => void;
  caption: string;
  timeHeading: string;
}) {
  const columns: TableColumn<MailItem>[] = [
    {
      key: "star",
      header: "Star",
      headerClassName: "table-column-star",
      cellClassName: "table-column-star",
      render: (item) => {
        const isStarred = starredIds.includes(item.id);
        return (
          <Button
            aria-label={`${isStarred ? "Remove star from" : "Star"} ${item.subject}`}
            aria-pressed={isStarred}
            className={isStarred ? "star-button is-starred" : "star-button"}
            onClick={() => onToggleStar(item.id)}
            variant="icon"
          >
            <Icon name="star" size={17} />
          </Button>
        );
      }
    },
    {
      key: "sender",
      header: "Sender",
      render: (item) => (
        <div className="sender-cell">
          <span aria-hidden="true" className={`sender-avatar sender-avatar--${item.avatarTone}`}>{item.initials}</span>
          <span className="sender-cell__copy">
            <span className={item.unread ? "sender-name is-unread" : "sender-name"}>{item.sender}</span>
            <span className="sender-address">{item.address}</span>
          </span>
        </div>
      )
    },
    {
      key: "subject",
      header: "Subject",
      cellClassName: "table-column-subject",
      render: (item) => (
        <div className="subject-cell">
          <button
            aria-label={`Open thread: ${item.subject}`}
            className={item.unread ? "subject-cell__title subject-cell__link is-unread" : "subject-cell__title subject-cell__link"}
            onClick={() => onOpenEmail(item.id)}
            type="button"
          >{item.subject}</button>
          <span className="subject-cell__preview">{item.preview}</span>
        </div>
      )
    },
    { key: "category", header: "Category", cellClassName: "table-column-category", render: (item) => <Badge tone={item.categoryTone}>{item.category}</Badge> },
    { key: "priority", header: "Priority", cellClassName: "table-column-priority", render: (item) => <Badge tone={PRIORITY_TONES[item.priority]}>{item.priority}</Badge> },
    { key: "status", header: "Status", cellClassName: "table-column-status", render: (item) => <Badge tone={item.statusTone}>{item.status}</Badge> },
    { key: "time", header: timeHeading, cellClassName: "table-column-time", render: (item) => <time className="mail-time" dateTime={item.dateTime}>{item.timeLabel}</time> }
  ];

  return (
    <DataTable
      caption={caption}
      columns={columns}
      rowClassName={(item) => item.unread ? "mail-row mail-row--unread" : "mail-row"}
      rows={items}
    />
  );
}

export function MobileMailList({
  items,
  starredIds,
  onToggleStar,
  onOpenEmail
}: {
  items: MailItem[];
  starredIds: string[];
  onToggleStar: (id: string) => void;
  onOpenEmail: (id: string) => void;
}) {
  return (
    <ul aria-label="Email messages" className="mobile-mail-list">
      {items.map((item) => {
        const isStarred = starredIds.includes(item.id);
        return (
          <li className={item.unread ? "mobile-mail-card mobile-mail-card--unread" : "mobile-mail-card"} key={item.id}>
            <div className="mobile-mail-card__top">
              <div className="sender-cell">
                <span aria-hidden="true" className={`sender-avatar sender-avatar--${item.avatarTone}`}>{item.initials}</span>
                <span className="sender-cell__copy">
                  <span className={item.unread ? "sender-name is-unread" : "sender-name"}>{item.sender}</span>
                  <span className="sender-address">{item.address}</span>
                </span>
              </div>
              <Button
                aria-label={`${isStarred ? "Remove star from" : "Star"} ${item.subject}`}
                aria-pressed={isStarred}
                className={isStarred ? "star-button is-starred" : "star-button"}
                onClick={() => onToggleStar(item.id)}
                variant="icon"
              >
                <Icon name="star" size={17} />
              </Button>
            </div>
            <div className="mobile-mail-card__subject">
              <button
                aria-label={`Open thread: ${item.subject}`}
                className={item.unread ? "subject-cell__title subject-cell__link is-unread" : "subject-cell__title subject-cell__link"}
                onClick={() => onOpenEmail(item.id)}
                type="button"
              >{item.subject}</button>
              <span className="subject-cell__preview">{item.preview}</span>
            </div>
            <time className="mobile-mail-card__time mail-time" dateTime={item.dateTime}>{item.timeLabel}</time>
            <div aria-label="Message details" className="mobile-mail-card__badges">
              <Badge tone={item.categoryTone}>{item.category}</Badge>
              <Badge tone={PRIORITY_TONES[item.priority]}>{item.priority} priority</Badge>
              <Badge tone={item.statusTone}>{item.status}</Badge>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
