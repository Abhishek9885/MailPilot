import type { MailCategory, MailFilter, MailItem, MailPriority, MailStatus } from "./mock-mail";

export interface MailFilters {
  query: string;
  filter: MailFilter;
  category: MailCategory | "all";
  status: MailStatus | "all";
}

export interface InboxSummary {
  total: number;
  unread: number;
  highPriority: number;
  needsReply: number;
  priorityCounts: Record<MailPriority, number>;
}

export interface MailPage {
  items: MailItem[];
  page: number;
  pageCount: number;
  start: number;
  end: number;
  total: number;
}

export const MAIL_PAGE_SIZE = 8;

export function filterMail(items: MailItem[], filters: MailFilters, starredIds: string[]): MailItem[] {
  const query = filters.query.trim().toLocaleLowerCase();

  return items.filter((item) => {
    if (filters.filter === "unread" && !item.unread) return false;
    if (filters.filter === "starred" && !starredIds.includes(item.id)) return false;
    if (filters.filter === "priority" && item.priority !== "urgent" && item.priority !== "high") return false;
    if (filters.category !== "all" && item.category !== filters.category) return false;
    if (filters.status !== "all" && item.status !== filters.status) return false;

    if (!query) return true;
    const searchableText = `${item.sender} ${item.address} ${item.subject} ${item.preview} ${item.category} ${item.status} ${item.priority}`;
    return searchableText.toLocaleLowerCase().includes(query);
  });
}

export function paginateMail(items: MailItem[], requestedPage: number, pageSize = MAIL_PAGE_SIZE): MailPage {
  const total = items.length;
  const pageCount = Math.ceil(total / pageSize);
  const page = Math.min(Math.max(Math.floor(requestedPage), 1), Math.max(pageCount, 1));
  const offset = (page - 1) * pageSize;

  return {
    items: items.slice(offset, offset + pageSize),
    page,
    pageCount,
    start: total === 0 ? 0 : offset + 1,
    end: Math.min(offset + pageSize, total),
    total
  };
}

export function summarizeInbox(items: MailItem[]): InboxSummary {
  const priorityCounts: Record<MailPriority, number> = { urgent: 0, high: 0, normal: 0, low: 0 };
  for (const item of items) priorityCounts[item.priority] += 1;

  return {
    total: items.length,
    unread: items.filter((item) => item.unread).length,
    highPriority: priorityCounts.urgent + priorityCounts.high,
    needsReply: items.filter((item) => item.status === "Needs reply").length,
    priorityCounts
  };
}
