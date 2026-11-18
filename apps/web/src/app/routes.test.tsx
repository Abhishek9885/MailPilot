import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import HomePage from "./(workspace)/page";
import AgentRoute from "./(workspace)/agent/page";
import ApprovalsRoute from "./(workspace)/approvals/page";
import TasksRoute from "./(workspace)/tasks/page";
import ActivityRoute from "./(workspace)/activity/page";
import SettingsRoute from "./(workspace)/settings/page";
import { APP_PATHS } from "@/lib/app-routes";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() })
}));

const plannedRoutes: { path: string; title: string; page: ComponentType }[] = [
  { path: "/", title: "Dashboard", page: HomePage },
  { path: "/agent", title: "Agent", page: AgentRoute },
  { path: "/approvals", title: "Approvals", page: ApprovalsRoute },
  { path: "/tasks", title: "Tasks", page: TasksRoute },
  { path: "/activity", title: "Activity", page: ActivityRoute },
  { path: "/settings", title: "Settings", page: SettingsRoute }
];

describe("planned application routes", () => {
  it.each(plannedRoutes)("renders $path with its active navigation item", ({ path, title, page }) => {
    const markup = renderToStaticMarkup(createElement(page));

    expect(markup).toContain(`<h1>${title}</h1>`);
    expect(markup).toContain(`href="${path}"`);
    expect(markup).toContain('aria-current="page"');
  });

  it("provides a unique path for each navigation destination", () => {
    const paths = Object.values(APP_PATHS);

    expect(paths).toContain("/agent");
    expect(paths).toContain("/approvals");
    expect(paths).toContain("/tasks");
    expect(paths).toContain("/activity");
    expect(paths).toContain("/settings");
    expect(new Set(paths).size).toBe(paths.length);
  });
});
