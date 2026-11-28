import { randomUUID } from "node:crypto";
import { EmailAnalysisSchemaVersion, type EmailAnalysisServiceResponse } from "@mailpilot/shared";
import { describe, expect, it } from "vitest";
import {
  buildTaskCommitmentSyncPlan,
  commitmentStatusIsTerminal,
  taskStatusIsTerminal
} from "../src/tasks/task-commitment-service.js";

function analysisResult(
  updates: Partial<EmailAnalysisServiceResponse["analysis"]> = {},
  sourceRevision = 1
): EmailAnalysisServiceResponse {
  return {
    userId: randomUUID(),
    emailId: randomUUID(),
    sourceRevision,
    schemaVersion: EmailAnalysisSchemaVersion,
    provider: "test-provider",
    modelVersion: "test-model-v1",
    responseId: null,
    providerRequestId: null,
    usage: null,
    analysis: {
      categories: ["work"],
      priority: "normal",
      summary: "A source-linked task and commitment.",
      actionItems: [{
        task: "Send the draft report",
        owner: "user",
        dueDate: "2026-12-04",
        dueDateBasis: "explicit",
        evidence: "I will send the draft report by Friday."
      }],
      deadlines: [],
      commitments: [{
        speaker: "sender",
        commitment: "The sender will review the draft report.",
        dueDate: "2026-12-05",
        evidence: "I will review the draft report on Saturday."
      }],
      eventCandidates: [],
      ...updates
    }
  };
}

describe("task and commitment candidate service", () => {
  it("builds owner and source-linked candidates with date-only UTC and unknown confidence", () => {
    const observedAt = new Date("2026-11-20T10:00:00.000Z");
    const result = analysisResult();

    const plan = buildTaskCommitmentSyncPlan(result, "connection-123", "thread-123", observedAt);

    expect(plan).toMatchObject({
      userId: result.userId,
      sourceEmailId: result.emailId,
      sourceThreadId: "thread-123",
      sourceRevision: 1,
      observedAt
    });
    expect(plan.tasks[0]).toMatchObject({
      title: "Send the draft report",
      assignee: "user",
      dueAt: new Date("2026-12-04T00:00:00.000Z"),
      dueTimezone: null,
      confidence: null,
      sourceEvidence: "I will send the draft report by Friday."
    });
    expect(plan.commitments[0]).toMatchObject({
      speaker: "sender",
      statement: "The sender will review the draft report.",
      dueAt: new Date("2026-12-05T00:00:00.000Z"),
      dueTimezone: null,
      confidence: null,
      sourceEvidence: "I will review the draft report on Saturday."
    });
  });

  it("keeps identity stable when a later message changes only due date and evidence", () => {
    const first = buildTaskCommitmentSyncPlan(analysisResult(), "connection-123", "thread-123");
    const updated = buildTaskCommitmentSyncPlan(analysisResult({
      actionItems: [{
        task: "Send the draft report",
        owner: "user",
        dueDate: "2026-12-08",
        dueDateBasis: "explicit",
        evidence: "I can send the draft report by Tuesday instead."
      }],
      commitments: [{
        speaker: "sender",
        commitment: "The sender will review the draft report.",
        dueDate: "2026-12-09",
        evidence: "I can review the draft report by Wednesday instead."
      }]
    }), "connection-123", "thread-123");

    expect(updated.tasks[0]?.deduplicationKey).toBe(first.tasks[0]?.deduplicationKey);
    expect(updated.commitments[0]?.deduplicationKey)
      .toBe(first.commitments[0]?.deduplicationKey);
    expect(updated.tasks[0]?.dueAt).toEqual(new Date("2026-12-08T00:00:00.000Z"));
    expect(updated.commitments[0]?.dueAt).toEqual(new Date("2026-12-09T00:00:00.000Z"));
  });

  it("deduplicates repeated action-item extraction in one analysis", () => {
    const repeatedAction = {
      task: "Send the draft report",
      owner: "user" as const,
      dueDate: "2026-12-04",
      dueDateBasis: "explicit" as const,
      evidence: "I will send the draft report by Friday."
    };
    const plan = buildTaskCommitmentSyncPlan(analysisResult({
      actionItems: [repeatedAction, repeatedAction]
    }), "connection-123", "thread-123");

    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]?.dueDateSource).toBe("explicit");
  });

  it("keeps a missing deadline null and labels it as not stated", () => {
    const plan = buildTaskCommitmentSyncPlan(analysisResult({
      actionItems: [{
        task: "Prepare the project outline",
        owner: "user",
        dueDate: null,
        dueDateBasis: "none",
        evidence: "Please prepare the project outline."
      }]
    }), "connection-123", "thread-123");

    expect(plan.tasks[0]).toMatchObject({ dueAt: null, dueDateSource: "none" });
  });

  it("preserves inferred deadline provenance", () => {
    const plan = buildTaskCommitmentSyncPlan(analysisResult({
      actionItems: [{
        task: "Prepare the project outline",
        owner: "user",
        dueDate: "2026-12-04",
        dueDateBasis: "inferred",
        evidence: "Please prepare this before our confirmed review."
      }]
    }), "connection-123", "thread-123");

    expect(plan.tasks[0]?.dueDateSource).toBe("inferred");
  });

  it("does not merge materially different commitment statements", () => {
    const first = buildTaskCommitmentSyncPlan(analysisResult(), "connection-123", "thread-123");
    const changed = buildTaskCommitmentSyncPlan(analysisResult({
      commitments: [{
        speaker: "sender",
        commitment: "The sender will deliver the final contract.",
        dueDate: "2026-12-05",
        evidence: "I will deliver the final contract."
      }]
    }), "connection-123", "thread-123");

    expect(changed.commitments[0]?.deduplicationKey)
      .not.toBe(first.commitments[0]?.deduplicationKey);
  });

  it("marks terminal user states so syncs cannot reopen them", () => {
    expect(taskStatusIsTerminal("completed")).toBe(true);
    expect(taskStatusIsTerminal("active")).toBe(false);
    expect(commitmentStatusIsTerminal("fulfilled")).toBe(true);
    expect(commitmentStatusIsTerminal("active")).toBe(false);
  });

  it("requires a non-empty source thread ID", () => {
    expect(() => buildTaskCommitmentSyncPlan(analysisResult(), "connection-123", "  "))
      .toThrow("Source connection and thread IDs are required");
  });
});
