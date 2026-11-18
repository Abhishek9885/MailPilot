import type { MailView } from "./mock-mail";

export const APP_PATHS: Record<MailView, string> = {
  dashboard: "/",
  inbox: "/inbox",
  drafts: "/drafts",
  approvals: "/approvals",
  tasks: "/tasks",
  archive: "/archive",
  agent: "/agent",
  activity: "/activity",
  settings: "/settings"
};
