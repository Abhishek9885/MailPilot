import type { ReactNode } from "react";

export type IconName =
  | "inbox"
  | "drafts"
  | "approvals"
  | "tasks"
  | "archive"
  | "search"
  | "bell"
  | "menu"
  | "close"
  | "plus"
  | "star"
  | "sparkles"
  | "clock"
  | "check"
  | "arrow"
  | "mail"
  | "refresh"
  | "alert"
  | "settings";

const paths: Record<IconName, ReactNode> = {
  inbox: <><path d="M4 5.5h16v13H4z" /><path d="M4 13h4l1.5 2h5L16 13h4" /></>,
  drafts: <><path d="M5 4.5h10l4 4v11H5z" /><path d="M14.5 4.5v4h4" /><path d="M8 13h8M8 16h6" /></>,
  approvals: <><path d="M12 3.5 19 6v5.5c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6z" /><path d="m9 11.5 2 2 4-4" /></>,
  tasks: <><rect x="4.5" y="4.5" width="15" height="15" rx="2" /><path d="m8 9 1.2 1.2L11.5 8M13.5 9h3M8 15l1.2 1.2 2.3-2.2M13.5 15h3" /></>,
  archive: <><path d="M4 6h16v3H4zM5.5 9v10h13V9M9 13h6" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4 4" /></>,
  bell: <><path d="M18 9a6 6 0 0 0-12 0c0 7-2.5 7-2.5 8.5h17C20.5 16 18 16 18 9ZM10 21h4" /></>,
  menu: <><path d="M4 6.5h16M4 12h16M4 17.5h16" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  star: <path d="m12 3.8 2.55 5.17 5.7.83-4.12 4.02.97 5.68L12 16.82l-5.1 2.68.97-5.68-4.12-4.02 5.7-.83z" />,
  sparkles: <><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z" /><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.2 2" /></>,
  check: <path d="m5 12.5 4.5 4L19 7" />,
  arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4.5 7 7.5 5.5L19.5 7" /></>,
  refresh: <><path d="M20 7v5h-5" /><path d="M19 12a7 7 0 1 1-2-5" /></>,
  alert: <><path d="M12 3.8 21 20H3z" /><path d="M12 9v4.5M12 17h.01" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a7.7 7.7 0 0 1-1.4.8l-.3 1.8h-2.8l-.3-1.8a7.7 7.7 0 0 1-1.4-.8l-1.7.7-1.4-2.4 1.4-1.1a7.5 7.5 0 0 1 0-1.6l-1.4-1.1 1.4-2.4 1.7.7a7.7 7.7 0 0 1 1.4-.8l.3-1.8h2.8l.3 1.8a7.7 7.7 0 0 1 1.4.8l1.7-.7 1.4 2.4-1.4 1.1a7.5 7.5 0 0 1 0 1.6Z" /></>
};

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      focusable="false"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width={size}
    >
      {paths[name]}
    </svg>
  );
}
