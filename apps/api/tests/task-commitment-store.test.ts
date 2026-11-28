import { randomUUID } from "node:crypto";
import { EmailAnalysisSchemaVersion } from "@mailpilot/shared";
import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "../src/generated/prisma/client.js";
import { buildTaskCommitmentSyncPlan } from "../src/tasks/task-commitment-service.js";
import { PrismaTaskCommitmentStore } from "../src/tasks/task-commitment-store.js";

function plan() {
  return buildTaskCommitmentSyncPlan({
    userId: randomUUID(),
    emailId: randomUUID(),
    sourceRevision: 2,
    schemaVersion: EmailAnalysisSchemaVersion,
    provider: "test-provider",
    modelVersion: "test-model-v1",
    responseId: null,
    providerRequestId: null,
    usage: null,
    analysis: {
      categories: ["work"],
      priority: "normal",
      summary: "Updated action and commitment.",
      actionItems: [{
        task: "Send the report",
        owner: "user",
        dueDate: "2026-12-04",
        dueDateBasis: "explicit",
        evidence: "I will send it by Friday instead."
      }],
      deadlines: [],
      commitments: [{
        speaker: "sender",
        commitment: "The sender will review the report.",
        dueDate: "2026-12-05",
        evidence: "I will review it on Saturday."
      }],
      eventCandidates: []
    }
  }, "connection-123", "thread-123", new Date("2026-11-20T10:00:00.000Z"));
}

function makeTransaction(
  taskStatus: string,
  commitmentStatus: string,
  taskDetails: { titleEditedAt: Date | null; dueDateSource: string } = {
    titleEditedAt: null,
    dueDateSource: "explicit"
  }
) {
  const task = {
    findUnique: vi.fn().mockResolvedValue({ id: randomUUID(), status: taskStatus, ...taskDetails }),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn()
  };
  const commitment = {
    findUnique: vi.fn().mockResolvedValue({ id: randomUUID(), status: commitmentStatus }),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn()
  };
  return {
    transaction: { task, commitment } as unknown as Prisma.TransactionClient,
    task,
    commitment
  };
}

describe("Prisma task and commitment synchronization", () => {
  it("updates open records with the latest evidence and due date without changing status", async () => {
    const { transaction, task, commitment } = makeTransaction("active", "active");
    const store = new PrismaTaskCommitmentStore({} as never);

    await store.syncAnalysis(transaction, plan());

    expect(task.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        userId_sourceConnectionId_sourceThreadId_deduplicationKey: expect.objectContaining({
          sourceConnectionId: "connection-123",
          sourceThreadId: "thread-123"
        })
      }
    }));
    expect(task.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        dueAt: new Date("2026-12-04T00:00:00.000Z"),
        sourceEvidence: "I will send it by Friday instead.",
        sourceRevision: 2
      })
    }));
    expect(task.update.mock.calls[0]?.[0].data).not.toHaveProperty("status");
    expect(commitment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        dueAt: new Date("2026-12-05T00:00:00.000Z"),
        sourceEvidence: "I will review it on Saturday."
      })
    }));
    expect(commitment.update.mock.calls[0]?.[0].data).not.toHaveProperty("status");
  });

  it("preserves terminal task and commitment lifecycle states during a new sync", async () => {
    const { transaction, task, commitment } = makeTransaction("completed", "fulfilled");
    const store = new PrismaTaskCommitmentStore({} as never);

    await store.syncAnalysis(transaction, plan());

    expect(task.update).not.toHaveBeenCalled();
    expect(task.create).not.toHaveBeenCalled();
    expect(commitment.update).not.toHaveBeenCalled();
    expect(commitment.create).not.toHaveBeenCalled();
  });

  it("keeps user-corrected task titles and dates during duplicate extraction refresh", async () => {
    const { transaction, task } = makeTransaction("active", "active", {
      titleEditedAt: new Date("2026-11-20T10:15:00.000Z"),
      dueDateSource: "user"
    });
    const store = new PrismaTaskCommitmentStore({} as never);

    await store.syncAnalysis(transaction, plan());

    const updatedData = task.update.mock.calls[0]?.[0].data;
    expect(updatedData).toMatchObject({ sourceEvidence: "I will send it by Friday instead." });
    expect(updatedData).not.toHaveProperty("title");
    expect(updatedData).not.toHaveProperty("dueAt");
    expect(updatedData).not.toHaveProperty("dueDateSource");
  });

  it("supersedes missing open candidates when the same source is reanalyzed", async () => {
    const { transaction, task, commitment } = makeTransaction("active", "active");
    const emptyPlan = buildTaskCommitmentSyncPlan({
      ...{
        userId: plan().userId,
        emailId: plan().sourceEmailId,
        sourceRevision: 2,
        schemaVersion: EmailAnalysisSchemaVersion,
        provider: "test-provider",
        modelVersion: "test-model-v1",
        responseId: null,
        providerRequestId: null,
        usage: null,
        analysis: {
          categories: ["work" as const],
          priority: "normal" as const,
          summary: "The message no longer supports an action.",
          actionItems: [],
          deadlines: [],
          commitments: [],
          eventCandidates: []
        }
      }
    }, "connection-123", "thread-123", new Date("2026-11-20T11:00:00.000Z"));
    const store = new PrismaTaskCommitmentStore({} as never);

    await store.syncAnalysis(transaction, emptyPlan);

    expect(task.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        sourceEmailId: emptyPlan.sourceEmailId,
        sourceRevision: { lte: 2 },
        status: { in: ["pending_review", "active"] }
      }),
      data: expect.objectContaining({ status: "superseded", supersededAt: emptyPlan.observedAt })
    }));
    expect(commitment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "superseded" })
    }));
  });
});
