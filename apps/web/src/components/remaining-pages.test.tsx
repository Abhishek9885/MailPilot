import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentPage, ActivityPage, ApprovalsPage, SettingsPage, TasksPage } from "./remaining-pages";
import { approvalReducer } from "@/lib/approval-state";
import { MOCK_MAIL } from "@/lib/mock-mail";
import { filterTasks } from "@/lib/workspace-page-utils";

describe("remaining workspace pages", () => {
  it("labels agent suggestions and keeps execution disabled", () => {
    const markup = renderToStaticMarkup(createElement(AgentPage, {
      onViewApprovals: () => undefined,
      onViewTasks: () => undefined
    }));

    expect(markup).toContain("Suggestions only");
    expect(markup).toContain("No agent run or email action has occurred");
    expect(markup).toContain("Execution disabled");
  });

  it("renders named approval actions and a local-only review explanation", () => {
    const markup = renderToStaticMarkup(createElement(ApprovalsPage));

    expect(markup).toContain('aria-label="Reply suggestions awaiting review"');
    expect(markup).toContain("Approve in preview");
    expect(markup).toContain("Reject suggestion");
    expect(markup).toContain("It does not send a message");
    expect(markup).toContain('aria-live="polite"');
  });

  it("keeps approval and rejection decisions stable per suggestion", () => {
    const approved = approvalReducer({}, { type: "decide", id: "approval-1", decision: "approved" });
    const stillApproved = approvalReducer(approved, { type: "decide", id: "approval-1", decision: "rejected" });
    const rejected = approvalReducer({}, { type: "decide", id: "approval-2", decision: "rejected" });

    expect(approved["approval-1"]).toBe("approved");
    expect(stillApproved).toBe(approved);
    expect(rejected["approval-2"]).toBe("rejected");
    expect(approvalReducer(approved, { type: "reset" })).toEqual({});
  });

  it("exposes accessible task filters and filters overdue and completed samples", () => {
    const tasks = MOCK_MAIL.filter((item) => item.view === "tasks");
    const markup = renderToStaticMarkup(createElement(TasksPage, { onOpenEmail: () => undefined }));

    expect(markup).toContain('aria-label="Filter tasks by status"');
    expect(markup).toContain('aria-pressed="true"');
    expect(filterTasks(tasks, "Overdue").map((task) => task.id)).toEqual(["task-4"]);
    expect(filterTasks(tasks, "Complete").map((task) => task.id)).toEqual(["task-5"]);
    expect(filterTasks(tasks, "open").every((task) => task.status !== "Complete")).toBe(true);
  });

  it("renders an ordered, timestamped activity history with source actions", () => {
    const markup = renderToStaticMarkup(createElement(ActivityPage, { onOpenEmail: () => undefined }));

    expect(markup).toContain('aria-label="Recent workspace activity"');
    expect(markup).toContain("Reply suggestion prepared");
    expect(markup).toContain('dateTime="2026-10-27T10:06:00+05:30"');
    expect(markup).toContain("View source");
  });

  it("associates settings labels with fields and makes local save status announceable", () => {
    const markup = renderToStaticMarkup(createElement(SettingsPage));

    expect(markup).toContain('for="settings-name"');
    expect(markup).toContain('id="settings-name"');
    expect(markup).toContain('for="settings-email"');
    expect(markup).toContain("Save preview settings");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("not synced");
  });
});
