import { describe, expect, it } from "vitest";
import { filterMail, paginateMail, summarizeInbox } from "./mail-utils";
import { MOCK_MAIL } from "./mock-mail";

const inbox = MOCK_MAIL.filter((item) => item.view === "inbox");
const starredIds = MOCK_MAIL.filter((item) => item.starred).map((item) => item.id);

describe("inbox mock data helpers", () => {
  it("searches across sender, address, subject, and message details", () => {
    const searchIds = (query: string) =>
      filterMail(
        inbox,
        {
          query,
          filter: "all",
          category: "all",
          status: "all"
        },
        starredIds
      ).map((item) => item.id);

    expect(searchIds("Mateo Alvarez")).toEqual(["mail-2"]);
    expect(searchIds("mateo@mailpilot.invalid")).toEqual(["mail-2"]);
    expect(searchIds("Updated client timeline")).toEqual(["mail-2"]);
    expect(searchIds("revised rollout")).toEqual(["mail-2"]);
  });

  it("combines priority, category, and status filters", () => {
    const matches = filterMail(
      inbox,
      {
        query: "",
        filter: "priority",
        category: "Finance",
        status: "Needs reply"
      },
      starredIds
    );

    expect(matches.map((item) => item.id)).toEqual(["mail-5"]);
  });

  it("paginates the inbox and clamps out-of-range pages", () => {
    const secondPage = paginateMail(inbox, 2);
    const lastPage = paginateMail(inbox, 20);

    expect(secondPage).toMatchObject({ page: 2, pageCount: 3, start: 9, end: 16, total: 24 });
    expect(secondPage.items).toHaveLength(8);
    expect(lastPage).toMatchObject({ page: 3, start: 17, end: 24 });
  });

  it("returns a stable summary for dashboard counts and priorities", () => {
    expect(summarizeInbox(inbox)).toEqual({
      total: 24,
      unread: 11,
      highPriority: 12,
      needsReply: 5,
      priorityCounts: { urgent: 3, high: 9, normal: 7, low: 5 }
    });
  });
});
