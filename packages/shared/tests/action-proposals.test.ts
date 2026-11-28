import { describe, expect, it } from "vitest";
import {
  ActionProposalSnapshotSchema,
  CreateActionProposalRequestSchema
} from "../src/index.js";

const USER_ID = "3d5e8475-42cc-4373-8bd0-f7ba82cb8339";
const RUN_ID = "596f21a1-e643-4cb9-a5c7-e2c7d95025c5";
const EMAIL_ID = "f0b24881-64bb-43be-9668-4caf619ea777";
const IDEMPOTENCY_KEY = "c2b85a77-9925-4743-8b2b-2a77ec5adf4f";

function sendEmailRequest(): {
  agentRunId: string;
  idempotencyKey: string;
  actionType: "send_email";
  payload: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    bodyText: string;
    replyToEmailId: string;
  };
  sourceEvidence: Array<{ emailId: string; threadId: string; sourceRevision: number; quote: string }>;
} {
  return {
    agentRunId: RUN_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    actionType: "send_email",
    payload: {
      to: ["recipient@example.com"],
      subject: "Re: Invoice 7314",
      bodyText: "Thanks for sending the invoice. I will review it today.",
      replyToEmailId: EMAIL_ID
    },
    sourceEvidence: [{
      emailId: EMAIL_ID,
      threadId: "gmail-thread-7314",
      sourceRevision: 2,
      quote: "Please review invoice 7314 today."
    }]
  };
}

describe("action proposal contracts", () => {
  it("validates an email action and applies explicit empty recipient defaults", () => {
    const parsed = CreateActionProposalRequestSchema.parse(sendEmailRequest());
    expect(parsed.actionType).toBe("send_email");
    if (parsed.actionType !== "send_email") throw new Error("Expected send_email action");
    expect(parsed.payload).toMatchObject({ cc: [], bcc: [], replyToEmailId: EMAIL_ID });
  });

  it("rejects invalid, duplicate, and excessive recipient addresses", () => {
    const invalidEmail = sendEmailRequest();
    invalidEmail.payload.to = ["not-an-email"];
    expect(CreateActionProposalRequestSchema.safeParse(invalidEmail).success).toBe(false);

    const duplicate = sendEmailRequest();
    duplicate.payload.cc = ["RECIPIENT@example.com"];
    expect(CreateActionProposalRequestSchema.safeParse(duplicate).success).toBe(false);

    const tooMany = sendEmailRequest();
    tooMany.payload.to = Array.from({ length: 10 }, (_, index) => `to-${index}@example.com`);
    tooMany.payload.cc = Array.from({ length: 10 }, (_, index) => `cc-${index}@example.com`);
    tooMany.payload.bcc = ["bcc@example.com"];
    expect(CreateActionProposalRequestSchema.safeParse(tooMany).success).toBe(false);
  });

  it("rejects blank and header-injected email content", () => {
    const blank = sendEmailRequest();
    blank.payload.bodyText = " \n\t ";
    expect(CreateActionProposalRequestSchema.safeParse(blank).success).toBe(false);

    const injectedSubject = sendEmailRequest();
    injectedSubject.payload.subject = "Invoice\r\nBcc: attacker@example.com";
    expect(CreateActionProposalRequestSchema.safeParse(injectedSubject).success).toBe(false);
  });

  it("requires evidence for a referenced reply message and rejects caller-owned fields", () => {
    const missingReplyEvidence = sendEmailRequest();
    missingReplyEvidence.sourceEvidence = [];
    expect(CreateActionProposalRequestSchema.safeParse(missingReplyEvidence).success).toBe(false);

    const spoofed = { ...sendEmailRequest(), userId: USER_ID };
    expect(CreateActionProposalRequestSchema.safeParse(spoofed).success).toBe(false);
  });

  it("requires derived risk, owner, and creation and expiry times in a valid snapshot", () => {
    const request = CreateActionProposalRequestSchema.parse(sendEmailRequest());
    const snapshot = {
      ...request,
      schemaVersion: "action-proposal-v1",
      userId: USER_ID,
      riskLevel: "high",
      createdAt: "2026-11-19T10:00:00.000Z",
      expiresAt: "2026-11-20T10:00:00.000Z"
    };
    expect(ActionProposalSnapshotSchema.parse(snapshot).payload).toEqual(request.payload);
    expect(ActionProposalSnapshotSchema.safeParse({ ...snapshot, riskLevel: "low" }).success).toBe(false);
    expect(ActionProposalSnapshotSchema.safeParse({
      ...snapshot,
      expiresAt: "2026-11-19T09:00:00.000Z"
    }).success).toBe(false);
  });

  it("validates the task and follow-up payloads in the explicit action allowlist", () => {
    const sourceEvidence = [{
      emailId: EMAIL_ID,
      threadId: "gmail-thread-7314",
      sourceRevision: 2,
      quote: "Please review invoice 7314 today."
    }];
    const taskRequest = CreateActionProposalRequestSchema.parse({
      agentRunId: RUN_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      actionType: "create_task",
      payload: {
        title: "Review invoice 7314",
        description: null,
        dueAt: "2026-11-20T10:00:00.000Z",
        sourceEmailId: EMAIL_ID
      },
      sourceEvidence
    });
    const followUpRequest = CreateActionProposalRequestSchema.parse({
      agentRunId: RUN_ID,
      idempotencyKey: "7154f564-c4e4-49d3-a366-01870062f68e",
      actionType: "schedule_follow_up",
      payload: { emailId: EMAIL_ID, scheduledAt: "2026-11-20T10:00:00.000Z" },
      sourceEvidence
    });

    expect(taskRequest.actionType).toBe("create_task");
    expect(followUpRequest.actionType).toBe("schedule_follow_up");
    expect(CreateActionProposalRequestSchema.safeParse({
      ...followUpRequest,
      actionType: "send_reply"
    }).success).toBe(false);
  });
});
