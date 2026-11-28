import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentPage, ActivityPage, ApprovalsPage, SettingsPage, TasksPage } from "./remaining-pages";
import { approvalReducer } from "@/lib/approval-state";

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

  it("renders saved approval review state and guarded Calendar execution copy", () => {
    const markup = renderToStaticMarkup(createElement(ApprovalsPage));

    expect(markup).toContain("Review the exact proposed action");
    expect(markup).toContain("Calendar events are created only after a separate approval and an explicit create action.");
    expect(markup).toContain("Loading saved action proposals");
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

  it("loads persisted tasks instead of showing preview fixtures", () => {
    const markup = renderToStaticMarkup(createElement(TasksPage));

    expect(markup).toContain("Tasks from conversations");
    expect(markup).toContain("AI action items are proposals");
    expect(markup).toContain("Loading saved tasks");
    expect(markup).not.toContain("sample data");
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
