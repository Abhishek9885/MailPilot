import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { EmailQueryService } from "../src/emails/email-query.js";

const ownerId = "89c10189-50b5-43f7-a222-2113d597a610";
const emailId = "0932b9cb-a0db-4314-9b88-771f9dcccf44";

describe("email query service", () => {
  it("lists bounded owner-scoped email summaries without selecting message bodies", async () => {
    const receivedAt = new Date("2026-10-28T12:00:00.000Z");
    const rows = [{
      id: emailId,
      subject: "Quarterly report",
      senderName: "Manager",
      senderEmailNormalized: "manager@example.invalid",
      receivedAt,
      labels: ["INBOX", "IMPORTANT"],
      sourceRevision: 3
    }];
    const capturedQueries: unknown[] = [];
    const findMany = vi.fn(async (query: unknown) => {
      capturedQueries.push(query);
      return rows;
    });
    const database = { email: { findMany } } as unknown as PrismaClient;
    const service = new EmailQueryService(database);

    const result = await service.list(ownerId, "10");

    expect(capturedQueries).toEqual([{
      where: { userId: ownerId, deletedAt: null },
      orderBy: [{ receivedAt: "desc" }, { id: "asc" }],
      take: 10,
      select: {
        id: true,
        subject: true,
        senderName: true,
        senderEmailNormalized: true,
        receivedAt: true,
        labels: true,
        sourceRevision: true
      }
    }]);
    expect(result).toEqual({
      emails: [{
        id: emailId,
        subject: "Quarterly report",
        senderName: "Manager",
        senderEmail: "manager@example.invalid",
        receivedAt: "2026-10-28T12:00:00.000Z",
        labels: ["INBOX", "IMPORTANT"],
        sourceRevision: 3
      }]
    });
  });
});
