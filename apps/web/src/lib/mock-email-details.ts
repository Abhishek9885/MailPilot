import type { MailItem } from "./mock-mail";

export interface ThreadMessage {
  id: string;
  sender: string;
  address: string;
  dateTime: string;
  timeLabel: string;
  body: string;
  direction: "incoming" | "outgoing";
}

export interface SuggestedAction {
  id: string;
  title: string;
  deadline: string;
  sourceMessageId: string;
}

export interface SourceReference {
  id: string;
  messageId: string;
  label: string;
  excerpt: string;
}

export interface MockEmailAnalysis {
  summary: string;
  actions: SuggestedAction[];
  proposedReply: string;
  sources: SourceReference[];
}

const brandReviewThread: ThreadMessage[] = [
  {
    id: "thread-message-1",
    sender: "Olivia Chen",
    address: "olivia@northstar.design",
    dateTime: "2026-10-26T16:42:00+05:30",
    timeLabel: "Yesterday, 4:42 PM",
    direction: "incoming",
    body: "Sharing the first direction before Friday's brand review. The updated deck is ready, and I would love your thoughts on the headline and color palette."
  },
  {
    id: "thread-message-2",
    sender: "Alex Morgan",
    address: "alex@acmestudio.example",
    dateTime: "2026-10-26T17:11:00+05:30",
    timeLabel: "Yesterday, 5:11 PM",
    direction: "outgoing",
    body: "Thanks, Olivia. I’ll review the deck and send notes before the meeting."
  },
  {
    id: "thread-message-current",
    sender: "Olivia Chen",
    address: "olivia@northstar.design",
    dateTime: "2026-10-27T09:42:00+05:30",
    timeLabel: "Today, 9:42 AM",
    direction: "incoming",
    body: "I added the updated direction and a few questions for the review. Could you send feedback on the headline and color palette by tomorrow at noon? The team will lock the deck after that."
  }
];

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function getMockThread(item: MailItem): ThreadMessage[] {
  if (item.id === "mail-1") return brandReviewThread;

  return [{
    id: "thread-message-current",
    sender: item.sender,
    address: item.address,
    dateTime: item.dateTime,
    timeLabel: item.timeLabel,
    direction: "incoming",
    body: item.preview
  }];
}

export function getMockEmailAnalysis(item: MailItem): MockEmailAnalysis {
  if (item.id === "mail-1") {
    return {
      summary: "Olivia shared the revised brand direction and is waiting for feedback on the headline and color palette before the team locks the deck.",
      actions: [
        { id: "action-headline", title: "Review the headline and color palette", deadline: "Tomorrow, Oct 28 at 12:00 PM", sourceMessageId: "thread-message-current" },
        { id: "action-reply", title: "Send Olivia your feedback before the deck is locked", deadline: "Tomorrow, Oct 28 at 12:00 PM", sourceMessageId: "thread-message-current" }
      ],
      proposedReply: "Hi Olivia,\n\nThanks for sharing the updated direction. I’ll review the headline and color palette and send my feedback before tomorrow at noon.\n\nBest,\nAlex",
      sources: [
        { id: "source-deadline", messageId: "thread-message-current", label: "Deadline", excerpt: "Could you send feedback ... by tomorrow at noon?" },
        { id: "source-review", messageId: "thread-message-current", label: "Requested review", excerpt: "feedback on the headline and color palette" },
        { id: "source-context", messageId: "thread-message-1", label: "Earlier context", excerpt: "thoughts on the headline and color palette" }
      ]
    };
  }

  const deadline = item.status === "Overdue"
    ? "Marked overdue"
    : item.status === "Due today"
      ? "Today"
      : item.status === "Due tomorrow"
        ? "Tomorrow"
        : "No deadline stated";
  const person = firstName(item.sender);

  return {
    summary: `${item.sender} sent a ${item.category.toLowerCase()} message about “${item.subject}.” ${item.preview}`,
    actions: [{
      id: "action-follow-up",
      title: item.status === "Needs reply" ? `Review the message and reply to ${person}` : `Review the next step for “${item.subject}”`,
      deadline,
      sourceMessageId: "thread-message-current"
    }],
    proposedReply: `Hi ${person},\n\nThanks for the update about ${item.subject}. I’ll review this and follow up with you soon.\n\nBest,\nAlex`,
    sources: [{
      id: "source-message",
      messageId: "thread-message-current",
      label: "Latest message",
      excerpt: item.preview
    }]
  };
}

export const MOCK_ANALYSIS_ERROR_EMAIL_ID = "mail-3";
