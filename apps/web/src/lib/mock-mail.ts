import type { BadgeTone } from "@/components/ui/badge";

export type MailDataView = "inbox" | "drafts" | "approvals" | "tasks" | "archive";
export type MailView = "dashboard" | MailDataView | "agent" | "activity" | "settings";
export type MailFilter = "all" | "unread" | "starred" | "priority";
export type MailPriority = "urgent" | "high" | "normal" | "low";
export type MailCategory =
  | "Calendar"
  | "Client"
  | "Events"
  | "Finance"
  | "Internal"
  | "Legal"
  | "Marketing"
  | "Operations"
  | "People"
  | "Personal"
  | "Product"
  | "Project"
  | "Security"
  | "Travel"
  | "Vendor";
export type MailStatus =
  | "Needs reply"
  | "Awaiting review"
  | "Waiting on them"
  | "In progress"
  | "Scheduled"
  | "For reference"
  | "Complete"
  | "Draft"
  | "Due today"
  | "Due tomorrow"
  | "Overdue"
  | "Approved";

export interface MailItem {
  id: string;
  view: MailDataView;
  sender: string;
  address: string;
  initials: string;
  avatarTone: "mint" | "violet" | "amber" | "blue" | "rose";
  subject: string;
  preview: string;
  timeLabel: string;
  dateTime: string;
  category: MailCategory;
  categoryTone: BadgeTone;
  priority: MailPriority;
  status: MailStatus;
  statusTone: BadgeTone;
  unread: boolean;
  starred: boolean;
}

type MailSeed = Omit<MailItem, "initials" | "avatarTone" | "categoryTone" | "statusTone">;

const avatarTones: MailItem["avatarTone"][] = ["mint", "violet", "amber", "blue", "rose"];

const categoryTones: Record<MailCategory, BadgeTone> = {
  Calendar: "blue",
  Client: "teal",
  Events: "neutral",
  Finance: "green",
  Internal: "blue",
  Legal: "amber",
  Marketing: "neutral",
  Operations: "blue",
  People: "neutral",
  Personal: "neutral",
  Product: "blue",
  Project: "teal",
  Security: "amber",
  Travel: "neutral",
  Vendor: "amber"
};

export const PRIORITY_TONES: Record<MailPriority, BadgeTone> = {
  urgent: "red",
  high: "amber",
  normal: "blue",
  low: "neutral"
};

const statusTones: Record<MailStatus, BadgeTone> = {
  "Needs reply": "teal",
  "Awaiting review": "amber",
  "Waiting on them": "neutral",
  "In progress": "blue",
  Scheduled: "blue",
  "For reference": "neutral",
  Complete: "green",
  Draft: "neutral",
  "Due today": "red",
  "Due tomorrow": "amber",
  Overdue: "red",
  Approved: "green"
};

const inboxSeeds: MailSeed[] = [
  { id: "mail-1", view: "inbox", sender: "Olivia Chen", address: "olivia@northstar.design", subject: "Brand review notes for Friday", preview: "I added the updated direction and a few questions for the review.", timeLabel: "Today, 9:42 AM", dateTime: "2026-10-27T09:42:00+05:30", category: "Client", priority: "high", status: "Needs reply", unread: true, starred: true },
  { id: "mail-2", view: "inbox", sender: "Mateo Alvarez", address: "mateo@fieldwork.co", subject: "Updated client timeline", preview: "The revised rollout gives us an extra week for user testing.", timeLabel: "Today, 9:18 AM", dateTime: "2026-10-27T09:18:00+05:30", category: "Project", priority: "high", status: "In progress", unread: true, starred: false },
  { id: "mail-3", view: "inbox", sender: "Priya Nair", address: "priya@brightline.legal", subject: "Re: Vendor agreement", preview: "Legal confirmed the updated language in section four. Could you review the final copy?", timeLabel: "Today, 8:54 AM", dateTime: "2026-10-27T08:54:00+05:30", category: "Legal", priority: "high", status: "Awaiting review", unread: true, starred: false },
  { id: "mail-4", view: "inbox", sender: "Jordan Lee", address: "jordan@orbitlabs.io", subject: "Q3 launch dates", preview: "Can we confirm Thursday, October 29 for the customer announcement?", timeLabel: "Today, 8:31 AM", dateTime: "2026-10-27T08:31:00+05:30", category: "Project", priority: "urgent", status: "Needs reply", unread: true, starred: true },
  { id: "mail-5", view: "inbox", sender: "Elena Rossi", address: "elena@northstar.design", subject: "Revised campaign estimate", preview: "The new estimate includes the photography and two rounds of edits.", timeLabel: "Today, 8:06 AM", dateTime: "2026-10-27T08:06:00+05:30", category: "Finance", priority: "high", status: "Needs reply", unread: true, starred: false },
  { id: "mail-6", view: "inbox", sender: "Marcus Reed", address: "marcus@fieldwork.co", subject: "Production handoff: incident follow-up", preview: "The customer is waiting on our revised mitigation plan before noon.", timeLabel: "Today, 7:48 AM", dateTime: "2026-10-27T07:48:00+05:30", category: "Operations", priority: "urgent", status: "Due today", unread: true, starred: true },
  { id: "mail-7", view: "inbox", sender: "Naomi Patel", address: "naomi@orbitlabs.io", subject: "New teammate onboarding checklist", preview: "Sharing the access checklist for Friday's start date.", timeLabel: "Today, 7:20 AM", dateTime: "2026-10-27T07:20:00+05:30", category: "People", priority: "normal", status: "For reference", unread: false, starred: false },
  { id: "mail-8", view: "inbox", sender: "Felix Grant", address: "felix@harbor-supply.com", subject: "Annual renewal quote", preview: "Your current rate is held through October 30. Let me know if you'd like to proceed.", timeLabel: "Today, 6:56 AM", dateTime: "2026-10-27T06:56:00+05:30", category: "Vendor", priority: "high", status: "Needs reply", unread: true, starred: false },
  { id: "mail-9", view: "inbox", sender: "Sara Kim", address: "sara@ledgerlane.io", subject: "September invoice receipt", preview: "Payment posted successfully. The receipt is attached for your records.", timeLabel: "Yesterday, 5:22 PM", dateTime: "2026-10-26T17:22:00+05:30", category: "Finance", priority: "low", status: "Complete", unread: false, starred: false },
  { id: "mail-10", view: "inbox", sender: "Northstar Studio", address: "hello@northstar.design", subject: "Your weekly project snapshot", preview: "A quick look at the milestones and decisions from this week.", timeLabel: "Yesterday, 4:10 PM", dateTime: "2026-10-26T16:10:00+05:30", category: "Client", priority: "normal", status: "For reference", unread: false, starred: false },
  { id: "mail-11", view: "inbox", sender: "Daniel Wu", address: "daniel@paperkite.app", subject: "Feedback from the beta group", preview: "The top requests were keyboard shortcuts and a clearer export flow.", timeLabel: "Yesterday, 3:44 PM", dateTime: "2026-10-26T15:44:00+05:30", category: "Product", priority: "normal", status: "In progress", unread: true, starred: false },
  { id: "mail-12", view: "inbox", sender: "Nina Park", address: "nina@orbitlabs.io", subject: "Kickoff meeting confirmed", preview: "Tuesday at 10 works for everyone. I sent a calendar hold.", timeLabel: "Yesterday, 2:30 PM", dateTime: "2026-10-26T14:30:00+05:30", category: "Calendar", priority: "normal", status: "Scheduled", unread: false, starred: true },
  { id: "mail-13", view: "inbox", sender: "Amara Okafor", address: "amara@brightline.legal", subject: "Security questionnaire review", preview: "Two answers need an owner before we return this to procurement.", timeLabel: "Yesterday, 12:15 PM", dateTime: "2026-10-26T12:15:00+05:30", category: "Security", priority: "high", status: "Awaiting review", unread: true, starred: true },
  { id: "mail-14", view: "inbox", sender: "Theo Martin", address: "theo@paperkite.app", subject: "Design QA: settings page", preview: "The spacing fixes are live in the preview. Please check the mobile state.", timeLabel: "Yesterday, 11:08 AM", dateTime: "2026-10-26T11:08:00+05:30", category: "Product", priority: "normal", status: "In progress", unread: false, starred: false },
  { id: "mail-15", view: "inbox", sender: "Grace Liu", address: "grace@northstar.design", subject: "Introduction to the retail team", preview: "Connecting you with Andre and Jules ahead of next week's workshop.", timeLabel: "Oct 25, 4:45 PM", dateTime: "2026-10-25T16:45:00+05:30", category: "Client", priority: "low", status: "For reference", unread: false, starred: false },
  { id: "mail-16", view: "inbox", sender: "Ben Carter", address: "ben@harbor-supply.com", subject: "Shipment 8841 delayed", preview: "The replacement parts are now expected on Wednesday. Please confirm the new date works.", timeLabel: "Oct 25, 2:20 PM", dateTime: "2026-10-25T14:20:00+05:30", category: "Operations", priority: "high", status: "Needs reply", unread: true, starred: false },
  { id: "mail-17", view: "inbox", sender: "Isabel Diaz", address: "isabel@orbitlabs.io", subject: "Travel details for the summit", preview: "Your hotel and rail confirmation are ready in the travel portal.", timeLabel: "Oct 25, 1:04 PM", dateTime: "2026-10-25T13:04:00+05:30", category: "Travel", priority: "low", status: "Complete", unread: false, starred: false },
  { id: "mail-18", view: "inbox", sender: "Hugo Moreau", address: "hugo@fieldwork.co", subject: "October contractor hours", preview: "The team submitted hours for approval. Summary is in the shared sheet.", timeLabel: "Oct 24, 4:52 PM", dateTime: "2026-10-24T16:52:00+05:30", category: "Finance", priority: "normal", status: "Awaiting review", unread: false, starred: false },
  { id: "mail-19", view: "inbox", sender: "Aisha Rahman", address: "aisha@paperkite.app", subject: "API migration notes", preview: "The client migration guide is ready for one final technical review.", timeLabel: "Oct 24, 2:37 PM", dateTime: "2026-10-24T14:37:00+05:30", category: "Internal", priority: "high", status: "Awaiting review", unread: false, starred: true },
  { id: "mail-20", view: "inbox", sender: "Ethan Brooks", address: "ethan@brightline.legal", subject: "Action required: access review", preview: "Please confirm the two external accounts before the audit closes tomorrow.", timeLabel: "Oct 24, 1:18 PM", dateTime: "2026-10-24T13:18:00+05:30", category: "Security", priority: "urgent", status: "Due tomorrow", unread: true, starred: true },
  { id: "mail-21", view: "inbox", sender: "Sophie Laurent", address: "sophie@commonroom.studio", subject: "Studio newsletter: October", preview: "This month's events, new work, and a few useful resources.", timeLabel: "Oct 23, 5:05 PM", dateTime: "2026-10-23T17:05:00+05:30", category: "Marketing", priority: "low", status: "For reference", unread: false, starred: false },
  { id: "mail-22", view: "inbox", sender: "Victor Chen", address: "victor@paperkite.app", subject: "Release window for v2.8", preview: "We can ship the migration on Thursday if support coverage is confirmed.", timeLabel: "Oct 23, 3:26 PM", dateTime: "2026-10-23T15:26:00+05:30", category: "Product", priority: "high", status: "Waiting on them", unread: false, starred: false },
  { id: "mail-23", view: "inbox", sender: "Maya Thompson", address: "maya@orbitlabs.io", subject: "Interview feedback: senior designer", preview: "The panel notes are ready. Let me know if you want a debrief.", timeLabel: "Oct 23, 11:47 AM", dateTime: "2026-10-23T11:47:00+05:30", category: "People", priority: "normal", status: "Waiting on them", unread: false, starred: false },
  { id: "mail-24", view: "inbox", sender: "Owen Price", address: "owen@ledgerlane.io", subject: "Receipt for the team lunch", preview: "Thanks again for organizing. The itemized receipt is attached.", timeLabel: "Oct 22, 12:32 PM", dateTime: "2026-10-22T12:32:00+05:30", category: "Personal", priority: "low", status: "Complete", unread: false, starred: false }
];

const otherSeeds: MailSeed[] = [
  { id: "draft-1", view: "drafts", sender: "To Jordan Lee", address: "jordan@orbitlabs.io", subject: "Q3 launch dates", preview: "Thanks for sharing the new dates. Thursday works well for us.", timeLabel: "Today, 10:06 AM", dateTime: "2026-10-27T10:06:00+05:30", category: "Project", priority: "normal", status: "Draft", unread: false, starred: true },
  { id: "draft-2", view: "drafts", sender: "To Maya Patel", address: "maya@tandem.team", subject: "Thank you for the introduction", preview: "It was great meeting you. I would love to continue the conversation.", timeLabel: "Yesterday, 3:32 PM", dateTime: "2026-10-26T15:32:00+05:30", category: "People", priority: "low", status: "Draft", unread: false, starred: false },
  { id: "draft-3", view: "drafts", sender: "To Olivia Chen", address: "olivia@northstar.design", subject: "Friday review agenda", preview: "I pulled together a short agenda for the review.", timeLabel: "Oct 24, 4:18 PM", dateTime: "2026-10-24T16:18:00+05:30", category: "Client", priority: "normal", status: "Draft", unread: false, starred: false },
  { id: "approval-1", view: "approvals", sender: "MailPilot draft", address: "For Jordan Lee, Orbit Labs", subject: "Reply about Q3 launch dates", preview: "A reply is ready to review. No message will be sent without approval.", timeLabel: "Today, 10:06 AM", dateTime: "2026-10-27T10:06:00+05:30", category: "Project", priority: "high", status: "Awaiting review", unread: true, starred: false },
  { id: "approval-2", view: "approvals", sender: "MailPilot draft", address: "For Priya Nair, Brightline Legal", subject: "Confirming the revised agreement", preview: "Check the recipient and wording before approving this draft.", timeLabel: "Yesterday, 2:21 PM", dateTime: "2026-10-26T14:21:00+05:30", category: "Legal", priority: "high", status: "Awaiting review", unread: true, starred: false },
  { id: "approval-3", view: "approvals", sender: "MailPilot draft", address: "For Elena Rossi, Northstar Studio", subject: "Revised campaign estimate", preview: "A proposed reply includes the updated delivery estimate.", timeLabel: "Oct 24, 9:30 AM", dateTime: "2026-10-24T09:30:00+05:30", category: "Finance", priority: "normal", status: "Awaiting review", unread: false, starred: false },
  { id: "task-1", view: "tasks", sender: "Noah Kim", address: "noah@fieldwork.co", subject: "Send the final proposal estimate", preview: "The planning call is tomorrow morning. Send the estimate before then.", timeLabel: "Due today", dateTime: "2026-10-27T13:00:00+05:30", category: "Finance", priority: "urgent", status: "Due today", unread: false, starred: false },
  { id: "task-2", view: "tasks", sender: "Nina Park", address: "nina@orbitlabs.io", subject: "Schedule the project kickoff", preview: "Find a time next week to align on the first milestone.", timeLabel: "Due tomorrow", dateTime: "2026-10-28T12:00:00+05:30", category: "Calendar", priority: "high", status: "Due tomorrow", unread: false, starred: true },
  { id: "task-3", view: "tasks", sender: "Marcus Reed", address: "marcus@fieldwork.co", subject: "Share the incident mitigation plan", preview: "Send the revised plan to the customer after the internal review.", timeLabel: "Due today", dateTime: "2026-10-27T16:00:00+05:30", category: "Operations", priority: "high", status: "Due today", unread: false, starred: false },
  { id: "task-4", view: "tasks", sender: "Priya Nair", address: "priya@brightline.legal", subject: "Return the signed vendor addendum", preview: "The supplier needs the signed copy to keep the revised start date.", timeLabel: "Overdue · Oct 26", dateTime: "2026-10-26T17:00:00+05:30", category: "Legal", priority: "urgent", status: "Overdue", unread: false, starred: false },
  { id: "task-5", view: "tasks", sender: "Sara Kim", address: "sara@ledgerlane.io", subject: "Confirm September invoice receipt", preview: "The payment receipt was confirmed and filed for reference.", timeLabel: "Completed · Oct 25", dateTime: "2026-10-25T16:20:00+05:30", category: "Finance", priority: "low", status: "Complete", unread: false, starred: false },
  { id: "archive-1", view: "archive", sender: "Sam Rivera", address: "sam@commonroom.studio", subject: "Re: Workshop materials", preview: "Perfect, I have everything I need. Thanks for sending this over.", timeLabel: "Oct 23, 11:20 AM", dateTime: "2026-10-23T11:20:00+05:30", category: "Events", priority: "low", status: "Complete", unread: false, starred: false },
  { id: "archive-2", view: "archive", sender: "Ravi Shah", address: "ravi@ledgerlane.io", subject: "Receipt for the August retainer", preview: "The transfer is complete. Thank you for confirming the account details.", timeLabel: "Oct 20, 3:12 PM", dateTime: "2026-10-20T15:12:00+05:30", category: "Finance", priority: "low", status: "Complete", unread: false, starred: false },
  { id: "archive-3", view: "archive", sender: "Clara James", address: "clara@northstar.design", subject: "Final logo export", preview: "The SVG and PNG exports are in the shared folder.", timeLabel: "Oct 18, 10:54 AM", dateTime: "2026-10-18T10:54:00+05:30", category: "Client", priority: "normal", status: "Complete", unread: false, starred: false }
];

function initialsFromName(sender: string): string {
  return sender
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function makeMailItem(seed: MailSeed, index: number): MailItem {
  return {
    ...seed,
    initials: initialsFromName(seed.sender),
    avatarTone: avatarTones[index % avatarTones.length] ?? "mint",
    categoryTone: categoryTones[seed.category],
    statusTone: statusTones[seed.status]
  };
}

export const MOCK_MAIL: MailItem[] = [
  ...inboxSeeds.map(makeMailItem),
  ...otherSeeds.map((seed, index) => makeMailItem(seed, index + inboxSeeds.length))
];

export const MAIL_VIEW_CONTENT: Record<MailView, { title: string; description: string; emptyTitle: string }> = {
  dashboard: {
    title: "Dashboard",
    description: "A clear view of what needs your attention today.",
    emptyTitle: "Nothing needs your attention"
  },
  inbox: {
    title: "Inbox",
    description: "Find the conversations that need your attention.",
    emptyTitle: "Your inbox is clear"
  },
  drafts: {
    title: "Drafts",
    description: "Pick up where you left off. Drafts stay in your control.",
    emptyTitle: "No drafts yet"
  },
  approvals: {
    title: "Approvals",
    description: "Review every proposed reply before anything is sent.",
    emptyTitle: "Nothing needs your approval"
  },
  tasks: {
    title: "Tasks",
    description: "Follow-ups gathered from recent conversations.",
    emptyTitle: "No open follow-ups"
  },
  archive: {
    title: "Archive",
    description: "A quiet home for conversations you have wrapped up.",
    emptyTitle: "Your archive is empty"
  },
  agent: {
    title: "Agent",
    description: "Review suggestions and keep every next step under your control.",
    emptyTitle: "No agent suggestions"
  },
  activity: {
    title: "Activity",
    description: "A clear history of sample workspace events and suggested actions.",
    emptyTitle: "No recent activity"
  },
  settings: {
    title: "Settings",
    description: "Manage your local preview preferences.",
    emptyTitle: "No settings available"
  }
};
