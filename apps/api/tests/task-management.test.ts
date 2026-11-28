import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "../src/generated/prisma/client.js";
import {
  PrismaTaskManagementStore,
  TaskManagementService,
  type TaskManagementStore
} from "../src/tasks/task-management-service.js";

function taskRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-11-20T12:00:00.000Z");
  const emailId = randomUUID();
  const threadId = "gmail-thread-123";
  return {
    id: randomUUID(),
    title: "Send the revised report",
    assignee: "user" as const,
    status: "pending_review" as const,
    dueAt: new Date("2026-11-25T00:00:00.000Z"),
    dueTimezone: null,
    dueDateSource: "explicit" as const,
    confidence: null,
    sourceEmailId: emailId,
    sourceThreadId: threadId,
    sourceRevision: 2,
    sourceEvidence: "Please send the revised report by Wednesday.",
    titleEditedAt: null,
    lastObservedAt: now,
    reviewedAt: null,
    completedAt: null,
    dismissedAt: null,
    supersededAt: null,
    createdAt: now,
    updatedAt: now,
    sourceEmail: {
      id: emailId,
      providerThreadId: threadId,
      subject: "Updated report request",
      senderName: "Manager",
      senderEmailNormalized: "manager@example.test",
      receivedAt: now
    },
    ...overrides
  };
}

describe("task management service", () => {
  it("passes the authenticated owner and status filter to the task store", async () => {
    const store: TaskManagementStore = {
      list: vi.fn().mockResolvedValue({ tasks: [] }),
      update: vi.fn()
    };
    const service = new TaskManagementService(store);

    await expect(service.list("owner-123", "open")).resolves.toEqual({ tasks: [] });
    expect(store.list).toHaveBeenCalledWith("owner-123", "open");
    await expect(service.list("owner-123", "invalid")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects empty, extra, and invalid task updates", async () => {
    const store: TaskManagementStore = {
      list: vi.fn().mockResolvedValue({ tasks: [] }),
      update: vi.fn()
    };
    const service = new TaskManagementService(store);
    const taskId = randomUUID();

    await expect(service.update("owner-123", taskId, {})).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.update("owner-123", taskId, {
      title: "Changed task",
      userId: "attacker"
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.update("owner-123", "not-a-uuid", { status: "completed" }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(store.update).not.toHaveBeenCalled();
  });

  it("stores user corrections with owner scoping and returns source references", async () => {
    const userId = randomUUID();
    const taskId = randomUUID();
    const savedRow = taskRow({
      id: taskId,
      title: "Send the signed report",
      status: "active",
      dueAt: new Date("2026-11-30T00:00:00.000Z"),
      dueDateSource: "user",
      titleEditedAt: new Date("2026-11-20T12:00:00.000Z"),
      reviewedAt: new Date("2026-11-20T12:00:00.000Z")
    });
    const task = {
      findFirst: vi.fn()
        .mockResolvedValueOnce({
          id: taskId,
          status: "pending_review",
          reviewedAt: null,
          updatedAt: new Date("2026-11-20T11:00:00.000Z")
        })
        .mockResolvedValueOnce(savedRow),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    };
    const transaction = { task } as unknown as Prisma.TransactionClient;
    const database = {
      $transaction: vi.fn(async (
        callback: (transaction: Prisma.TransactionClient) => Promise<unknown>
      ) => callback(transaction))
    } as unknown as PrismaClient;
    const service = new TaskManagementService(new PrismaTaskManagementStore(database));

    const result = await service.update(userId, taskId, {
      title: "Send the signed report",
      dueDate: "2026-11-30"
    });

    expect(task.findFirst.mock.calls[0]?.[0].where).toEqual({ id: taskId, userId });
    expect(task.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: taskId,
        userId,
        status: { in: ["pending_review", "active"] },
        updatedAt: new Date("2026-11-20T11:00:00.000Z")
      },
      data: expect.objectContaining({
        title: "Send the signed report",
        dueAt: new Date("2026-11-30T00:00:00.000Z"),
        dueTimezone: null,
        dueDateSource: "user",
        status: "active",
        titleEditedAt: expect.any(Date),
        reviewedAt: expect.any(Date)
      })
    }));
    expect(result).toMatchObject({
      title: "Send the signed report",
      dueDateSource: "user",
      sourceEmail: { subject: "Updated report request", providerThreadId: "gmail-thread-123" }
    });
  });

  it.each(["completed", "dismissed"] as const)("records %s as a terminal lifecycle state", async (status) => {
    const userId = randomUUID();
    const taskId = randomUUID();
    const now = new Date("2026-11-20T12:00:00.000Z");
    const savedRow = taskRow({
      id: taskId,
      status,
      completedAt: status === "completed" ? now : null,
      dismissedAt: status === "dismissed" ? now : null,
      reviewedAt: now
    });
    const task = {
      findFirst: vi.fn()
        .mockResolvedValueOnce({
          id: taskId,
          status: "pending_review",
          reviewedAt: null,
          updatedAt: new Date("2026-11-20T11:00:00.000Z")
        })
        .mockResolvedValueOnce(savedRow),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    };
    const transaction = { task } as unknown as Prisma.TransactionClient;
    const database = {
      $transaction: async (
        callback: (transaction: Prisma.TransactionClient) => Promise<unknown>
      ) => callback(transaction)
    } as unknown as PrismaClient;
    const service = new TaskManagementService(new PrismaTaskManagementStore(database));

    const saved = await service.update(userId, taskId, { status });
    const write = task.updateMany.mock.calls[0]?.[0].data;

    expect(saved.status).toBe(status);
    expect(write).toMatchObject({
      status,
      reviewedAt: expect.any(Date),
      ...(status === "completed" ? { completedAt: expect.any(Date) } : { dismissedAt: expect.any(Date) })
    });
  });

  it("does not update a task owned by another user", async () => {
    const task = {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn()
    };
    const transaction = { task } as unknown as Prisma.TransactionClient;
    const database = {
      $transaction: async (
        callback: (transaction: Prisma.TransactionClient) => Promise<unknown>
      ) => callback(transaction)
    } as unknown as PrismaClient;
    const service = new TaskManagementService(new PrismaTaskManagementStore(database));
    const taskId = randomUUID();

    await expect(service.update(randomUUID(), taskId, { status: "dismissed" }))
      .rejects.toMatchObject({ statusCode: 404, code: "TASK_NOT_FOUND" });
    expect(task.updateMany).not.toHaveBeenCalled();
  });
});
