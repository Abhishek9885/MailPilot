import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import request from "supertest";
import { GoogleCalendarScope } from "@mailpilot/shared";
import { CalendarActionRuntime } from "../src/calendar/action-executor.js";
import type { CalendarEventSnapshot } from "../src/calendar/calendar-api.js";
import type { GoogleCalendarConnectionStore } from "../src/calendar/types.js";
import type { GoogleCalendarOAuthClient } from "../src/calendar/google-oauth.js";
import { createApp } from "../src/app.js";
import { hashSecret } from "../src/auth/cookies.js";
import type {
  AuthStore,
  CreateSessionInput,
  GoogleIdentity,
  SessionRecord
} from "../src/auth/types.js";
import { ActionProposalService } from "../src/actions/proposal-service.js";
import type {
  ActionProposalRecord,
  ActionProposalStore,
  CreateActionProposalRecord,
  ProposalAgentRun,
  ProposalSourceEmail
} from "../src/actions/proposal-store.js";
import type { ActionExecutor, ActionReconciler } from "../src/actions/executor.js";

const WEB_ORIGIN = "http://localhost:3000";
const OWNER_TOKEN = "o".repeat(43);
const OTHER_TOKEN = "x".repeat(43);
const OWNER_CSRF = "csrf-owner-proposal-test";
const OTHER_CSRF = "csrf-other-proposal-test";

class MemoryAuthStore implements AuthStore {
  private readonly sessions = new Map<string, SessionRecord>();

  public async authenticateGoogleIdentity(
    identity: GoogleIdentity,
    authenticatedAt: Date
  ): Promise<{ id: string; emailNormalized: string; status: "active" }> {
    void identity;
    void authenticatedAt;
    return { id: randomUUID(), emailNormalized: "new-user@example.test", status: "active" };
  }

  public async createSession(input: CreateSessionInput): Promise<{ id: string }> {
    void input;
    return { id: randomUUID() };
  }

  public async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return this.sessions.get(tokenHash) ?? null;
  }

  public async revokeSession(sessionId: string, userId: string, revokedAt: Date): Promise<void> {
    for (const [key, session] of this.sessions) {
      if (session.id === sessionId && session.userId === userId) {
        this.sessions.set(key, { ...session, revokedAt });
      }
    }
  }

  public seedSession(userId: string, email: string, token: string, csrfToken: string): void {
    this.sessions.set(hashSecret(token), {
      id: randomUUID(),
      userId,
      csrfTokenHash: hashSecret(csrfToken),
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      revokedAt: null,
      user: { emailNormalized: email, status: "active" }
    });
  }
}

class MemoryActionProposalStore implements ActionProposalStore {
  public readonly proposals: ActionProposalRecord[] = [];
  public readonly auditEvents: string[] = [];
  public readonly runs: Array<ProposalAgentRun & { userId: string }> = [];
  public readonly emails: Array<ProposalSourceEmail & { userId: string }> = [];

  public async findAgentRun(userId: string, agentRunId: string): Promise<ProposalAgentRun | null> {
    const run = this.runs.find((item) => item.userId === userId && item.id === agentRunId);
    return run ? { id: run.id, status: run.status } : null;
  }

  public async findSourceEmails(userId: string, emailIds: string[]): Promise<ProposalSourceEmail[]> {
    return this.emails.filter((email) => email.userId === userId && emailIds.includes(email.id))
      .map((email) => ({
        id: email.id,
        threadId: email.threadId,
        sourceRevision: email.sourceRevision,
        subject: email.subject,
        bodyText: email.bodyText
      }));
  }

  public async findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<ActionProposalRecord | null> {
    return this.proposals.find((proposal) => proposal.userId === userId && proposal.idempotencyKey === idempotencyKey) ?? null;
  }

  public async findById(userId: string, proposalId: string): Promise<ActionProposalRecord | null> {
    return this.proposals.find((proposal) => proposal.userId === userId && proposal.id === proposalId) ?? null;
  }

  public async createProposal(input: CreateActionProposalRecord): Promise<ActionProposalRecord> {
    const record: ActionProposalRecord = {
      id: randomUUID(),
      userId: input.userId,
      agentRunId: input.agentRunId,
      idempotencyKey: input.idempotencyKey,
      actionType: input.actionType,
      canonicalPayload: input.snapshot,
      payloadHash: input.payloadHash,
      status: "pending",
      executionKey: null,
      executionStartedAt: null,
      executionLeaseExpiresAt: null,
      executionAttempts: 0,
      executionResultCode: null,
      reconciliationClaimId: null,
      reconciliationLeaseExpiresAt: null,
      reconciliationAttempts: 0,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt
    };
    this.proposals.push(record);
    this.auditEvents.push("action_proposal.created");
    return record;
  }

  public async transitionProposal(input: Parameters<ActionProposalStore["transitionProposal"]>[0]): Promise<ActionProposalRecord | null> {
    const proposal = this.proposals.find((item) => item.userId === input.userId
      && item.id === input.proposalId
      && item.status === input.fromStatus
      && item.payloadHash === input.expectedPayloadHash
      && (input.expectedExecutionKey === undefined || item.executionKey === input.expectedExecutionKey)
      && (input.expectedReconciliationClaimId === undefined || item.reconciliationClaimId === input.expectedReconciliationClaimId)
      && (!input.expectedReconciliationClaimId
        || (item.reconciliationLeaseExpiresAt !== null && item.reconciliationLeaseExpiresAt.getTime() > input.now.getTime()))
      && (!input.requireUnexpired || item.expiresAt.getTime() > input.now.getTime()));
    if (!proposal) return null;
    proposal.status = input.toStatus;
    if (input.setExecutionKey) proposal.executionKey = input.setExecutionKey;
    if (input.executionStartedAt !== undefined) proposal.executionStartedAt = input.executionStartedAt;
    if (input.executionLeaseExpiresAt !== undefined) proposal.executionLeaseExpiresAt = input.executionLeaseExpiresAt;
    if (input.incrementExecutionAttempts) proposal.executionAttempts += 1;
    if (input.executionResultCode !== undefined) proposal.executionResultCode = input.executionResultCode;
    if (input.expectedReconciliationClaimId) {
      proposal.reconciliationClaimId = null;
      proposal.reconciliationLeaseExpiresAt = null;
    }
    this.auditEvents.push(`action_proposal.${input.toStatus}`);
    return proposal;
  }

  public async reconcileExpiredExecutions(userId: string, now: Date): Promise<void> {
    for (const proposal of this.proposals) {
      if (proposal.userId === userId && proposal.status === "executing"
        && proposal.executionLeaseExpiresAt && proposal.executionLeaseExpiresAt.getTime() <= now.getTime()) {
        proposal.status = "reconciliation_required";
        proposal.executionLeaseExpiresAt = null;
        proposal.executionResultCode = "EXECUTION_LEASE_EXPIRED";
        this.auditEvents.push("action_proposal.reconciliation_required");
      }
    }
  }

  public async claimReconciliation(
    userId: string,
    proposalId: string,
    payloadHash: string,
    claimId: string,
    now: Date,
    leaseExpiresAt: Date
  ): Promise<boolean> {
    const proposal = this.proposals.find((item) => item.userId === userId
      && item.id === proposalId
      && item.payloadHash === payloadHash
      && item.status === "reconciliation_required"
      && (!item.reconciliationLeaseExpiresAt || item.reconciliationLeaseExpiresAt.getTime() <= now.getTime()));
    if (!proposal) return false;
    proposal.reconciliationClaimId = claimId;
    proposal.reconciliationLeaseExpiresAt = leaseExpiresAt;
    proposal.reconciliationAttempts += 1;
    this.auditEvents.push("action_proposal.reconciliation_claimed");
    return true;
  }

  public async releaseReconciliation(
    userId: string,
    proposalId: string,
    payloadHash: string,
    claimId: string
  ): Promise<void> {
    const proposal = this.proposals.find((item) => item.userId === userId
      && item.id === proposalId
      && item.payloadHash === payloadHash
      && item.status === "reconciliation_required"
      && item.reconciliationClaimId === claimId);
    if (!proposal) return;
    proposal.reconciliationClaimId = null;
    proposal.reconciliationLeaseExpiresAt = null;
    this.auditEvents.push("action_proposal.reconciliation_checked");
  }

  public async expireDue(userId: string, now: Date): Promise<void> {
    for (const proposal of this.proposals) {
      if (proposal.userId === userId
        && (proposal.status === "pending" || proposal.status === "approved")
        && proposal.expiresAt.getTime() <= now.getTime()) {
        proposal.status = "expired";
        this.auditEvents.push("action_proposal.expired");
      }
    }
  }

  public async listProposals(userId: string, limit: number): Promise<ActionProposalRecord[]> {
    return this.proposals.filter((proposal) => proposal.userId === userId).slice(0, limit);
  }
}

function createTestApp(executor?: ActionExecutor, reconciler?: ActionReconciler, executionTimeoutMs?: number) {
  const ownerId = randomUUID();
  const otherUserId = randomUUID();
  const runId = randomUUID();
  const otherRunId = randomUUID();
  const emailId = randomUUID();
  const otherEmailId = randomUUID();
  const authStore = new MemoryAuthStore();
  authStore.seedSession(ownerId, "owner@example.test", OWNER_TOKEN, OWNER_CSRF);
  authStore.seedSession(otherUserId, "other@example.test", OTHER_TOKEN, OTHER_CSRF);
  const store = new MemoryActionProposalStore();
  store.runs.push(
    { id: runId, userId: ownerId, status: "completed" },
    { id: otherRunId, userId: otherUserId, status: "completed" }
  );
  store.emails.push(
    {
      id: emailId,
      userId: ownerId,
      threadId: "gmail-thread-owner-1",
      sourceRevision: 3,
      subject: "Invoice 7314",
      bodyText: "Please review invoice 7314 today and confirm the amount."
    },
    {
      id: otherEmailId,
      userId: otherUserId,
      threadId: "gmail-thread-other-1",
      sourceRevision: 1,
      subject: "Private message",
      bodyText: "This message belongs to another user and is private."
    }
  );
  let currentTime = new Date("2026-11-19T10:00:00.000Z");
  const service = new ActionProposalService(store, () => new Date(currentTime), executor, reconciler, executionTimeoutMs);
  const app = createApp({
    checkDatabase: async () => undefined,
    authStore,
    actionProposalService: service,
    logger: pino({ level: "silent" })
  });
  return {
    app,
    ownerId,
    otherUserId,
    runId,
    otherRunId,
    emailId,
    otherEmailId,
    store,
    service,
    setNow: (value: string) => { currentTime = new Date(value); }
  };
}

function validRequest(runId: string, emailId: string) {
  return {
    agentRunId: runId,
    idempotencyKey: "197e2ceb-7a9a-4070-85a0-b0e75a50092a",
    actionType: "send_email",
    payload: {
      to: ["recipient@example.com"],
      subject: "Re: Invoice 7314",
      bodyText: "Thanks for sending invoice 7314. I will review it today.",
      replyToEmailId: emailId
    },
    sourceEvidence: [{
      emailId,
      threadId: "gmail-thread-owner-1",
      sourceRevision: 3,
      quote: "Please review invoice 7314 today"
    }]
  };
}

function authenticatedPost(app: ReturnType<typeof createApp>, body: object, token = OWNER_TOKEN, csrf = OWNER_CSRF) {
  return request(app)
    .post("/v1/actions/proposals")
    .set("Origin", WEB_ORIGIN)
    .set("Cookie", `mailpilot_session=${token}; mailpilot_csrf=${csrf}`)
    .set("x-csrf-token", csrf)
    .send(body);
}

function authenticatedDecision(
  app: ReturnType<typeof createApp>,
  proposalId: string,
  decision: "approve" | "reject",
  payloadHash: string,
  token = OWNER_TOKEN,
  csrf = OWNER_CSRF
) {
  return request(app)
    .post(`/v1/actions/proposals/${proposalId}/${decision}`)
    .set("Origin", WEB_ORIGIN)
    .set("Cookie", `mailpilot_session=${token}; mailpilot_csrf=${csrf}`)
    .set("x-csrf-token", csrf)
    .send({ payloadHash });
}

function authenticatedExecute(
  app: ReturnType<typeof createApp>,
  proposalId: string,
  payloadHash: string,
  token = OWNER_TOKEN,
  csrf = OWNER_CSRF
) {
  return request(app)
    .post(`/v1/actions/proposals/${proposalId}/execute`)
    .set("Origin", WEB_ORIGIN)
    .set("Cookie", `mailpilot_session=${token}; mailpilot_csrf=${csrf}`)
    .set("x-csrf-token", csrf)
    .send({ payloadHash });
}

function authenticatedReconcile(
  app: ReturnType<typeof createApp>,
  proposalId: string,
  payloadHash: string,
  token = OWNER_TOKEN,
  csrf = OWNER_CSRF
) {
  return request(app)
    .post(`/v1/actions/proposals/${proposalId}/reconcile`)
    .set("Origin", WEB_ORIGIN)
    .set("Cookie", `mailpilot_session=${token}; mailpilot_csrf=${csrf}`)
    .set("x-csrf-token", csrf)
    .send({ payloadHash });
}

describe("action proposal API", () => {
  it("stores a hashed, pending, owner-bound snapshot without executing it", async () => {
    const { app, ownerId, runId, emailId, store } = createTestApp();
    const body = validRequest(runId, emailId);

    const response = await authenticatedPost(app, body);

    expect(response.status).toBe(201);
    expect(response.body.proposal).toMatchObject({
      status: "pending",
      execution: { attempts: 0, startedAt: null, leaseExpiresAt: null, resultCode: null },
      snapshot: {
        schemaVersion: "action-proposal-v1",
        userId: ownerId,
        agentRunId: runId,
        idempotencyKey: body.idempotencyKey,
        actionType: "send_email",
        riskLevel: "high",
        createdAt: "2026-11-19T10:00:00.000Z",
        expiresAt: "2026-11-20T10:00:00.000Z",
        payload: { to: ["recipient@example.com"], cc: [], bcc: [], subject: "Re: Invoice 7314" }
      }
    });
    expect(response.body.proposal.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(store.proposals).toHaveLength(1);

    const executionAttempt = await request(app)
      .post(`/v1/actions/proposals/${response.body.proposal.id}/execute`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", `mailpilot_session=${OWNER_TOKEN}; mailpilot_csrf=${OWNER_CSRF}`)
      .set("x-csrf-token", OWNER_CSRF);
    expect(executionAttempt.status).toBe(400);
    expect(store.proposals[0]?.status).toBe("pending");
  });

  it("requires sign-in and CSRF for proposal creation", async () => {
    const { app, runId, emailId, store } = createTestApp();
    const unauthenticated = await request(app).post("/v1/actions/proposals").send(validRequest(runId, emailId));
    const csrfRejected = await request(app)
      .post("/v1/actions/proposals")
      .set("Cookie", `mailpilot_session=${OWNER_TOKEN}`)
      .send(validRequest(runId, emailId));

    expect(unauthenticated.status).toBe(401);
    expect(csrfRejected.status).toBe(403);
    expect(store.proposals).toHaveLength(0);
  });

  it("rejects approval bound to a stale payload hash", async () => {
    const { app, runId, emailId, store } = createTestApp();
    const created = await authenticatedPost(app, validRequest(runId, emailId));
    const stale = await authenticatedDecision(app, created.body.proposal.id, "approve", "0".repeat(64));

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("ACTION_PROPOSAL_STALE");
    expect(store.proposals[0]?.status).toBe("pending");
  });

  it("does not accept payload edits alongside an approval", async () => {
    const { app, runId, emailId, store } = createTestApp();
    const created = await authenticatedPost(app, validRequest(runId, emailId));
    const editedApproval = await request(app)
      .post(`/v1/actions/proposals/${created.body.proposal.id}/approve`)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", `mailpilot_session=${OWNER_TOKEN}; mailpilot_csrf=${OWNER_CSRF}`)
      .set("x-csrf-token", OWNER_CSRF)
      .send({
        payloadHash: created.body.proposal.payloadHash,
        payload: { ...created.body.proposal.snapshot.payload, bodyText: "Changed after review" }
      });

    expect(editedApproval.status).toBe(400);
    expect(store.proposals[0]?.status).toBe("pending");
  });

  it("allows one approval and rejects duplicate decisions", async () => {
    const { app, runId, emailId, store } = createTestApp();
    const created = await authenticatedPost(app, validRequest(runId, emailId));
    const proposalId = created.body.proposal.id as string;
    const payloadHash = created.body.proposal.payloadHash as string;
    const first = await authenticatedDecision(app, proposalId, "approve", payloadHash);
    const duplicate = await authenticatedDecision(app, proposalId, "approve", payloadHash);

    expect(first.status).toBe(200);
    expect(first.body.proposal.status).toBe("approved");
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("ACTION_PROPOSAL_ALREADY_DECIDED");
    expect(store.proposals[0]?.status).toBe("approved");
  });

  it("allows only one of two concurrent approvals", async () => {
    const { app, runId, emailId, store } = createTestApp();
    const created = await authenticatedPost(app, validRequest(runId, emailId));
    const proposalId = created.body.proposal.id as string;
    const payloadHash = created.body.proposal.payloadHash as string;

    const results = await Promise.all([
      authenticatedDecision(app, proposalId, "approve", payloadHash),
      authenticatedDecision(app, proposalId, "approve", payloadHash)
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(store.proposals[0]?.status).toBe("approved");
    expect(store.auditEvents.filter((event) => event === "action_proposal.approved")).toHaveLength(1);
  });

  it("persists rejection and prevents a later approval", async () => {
    const { app, runId, emailId, store } = createTestApp();
    const created = await authenticatedPost(app, validRequest(runId, emailId));
    const proposalId = created.body.proposal.id as string;
    const payloadHash = created.body.proposal.payloadHash as string;
    const rejected = await authenticatedDecision(app, proposalId, "reject", payloadHash);
    const approveAfterReject = await authenticatedDecision(app, proposalId, "approve", payloadHash);

    expect(rejected.status).toBe(200);
    expect(rejected.body.proposal.status).toBe("rejected");
    expect(approveAfterReject.status).toBe(409);
    expect(store.proposals[0]?.status).toBe("rejected");
  });

  it("persists EXPIRED and refuses an approval at the exact expiry time", async () => {
    const { app, runId, emailId, store, setNow } = createTestApp();
    const created = await authenticatedPost(app, validRequest(runId, emailId));
    setNow("2026-11-20T10:00:00.000Z");
    const expired = await authenticatedDecision(
      app,
      created.body.proposal.id as string,
      "approve",
      created.body.proposal.payloadHash as string
    );

    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe("ACTION_PROPOSAL_EXPIRED");
    expect(store.proposals[0]?.status).toBe("expired");
  });

  it("hides another user's proposal from approval attempts", async () => {
    const { app, runId, emailId, store } = createTestApp();
    const created = await authenticatedPost(app, validRequest(runId, emailId));
    const unauthorized = await authenticatedDecision(
      app,
      created.body.proposal.id as string,
      "approve",
      created.body.proposal.payloadHash as string,
      OTHER_TOKEN,
      OTHER_CSRF
    );

    expect(unauthorized.status).toBe(404);
    expect(store.proposals[0]?.status).toBe("pending");
  });

  it("runs only the mock executor after approval and records the lifecycle", async () => {
    const executorCalls: string[] = [];
    const executionKeys: string[] = [];
    const executor: ActionExecutor = {
      async execute(snapshot, context) {
        executorCalls.push(snapshot.actionType === "send_email" ? snapshot.payload.bodyText : snapshot.actionType);
        executionKeys.push(context.idempotencyKey);
        return { status: "succeeded" };
      }
    };
    const { app, runId, emailId, store } = createTestApp(executor);
    const created = await authenticatedPost(app, validRequest(runId, emailId));
    const proposalId = created.body.proposal.id as string;
    const payloadHash = created.body.proposal.payloadHash as string;
    await authenticatedDecision(app, proposalId, "approve", payloadHash);

    const executed = await authenticatedExecute(app, proposalId, payloadHash);
    const duplicate = await authenticatedExecute(app, proposalId, payloadHash);

    expect(executed.status).toBe(200);
    expect(executed.body.proposal.status).toBe("succeeded");
    expect(executed.body.proposal.execution).toMatchObject({ attempts: 1, resultCode: "EXECUTION_SUCCEEDED" });
    expect(executorCalls).toEqual(["Thanks for sending invoice 7314. I will review it today."]);
    expect(executionKeys).toHaveLength(1);
    expect(executionKeys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(executed.body.proposal.executionKey).toBeUndefined();
    expect(store.auditEvents).toEqual([
      "action_proposal.created",
      "action_proposal.approved",
      "action_proposal.executing",
      "action_proposal.succeeded"
    ]);
    expect(duplicate.status).toBe(409);
  });

  it("creates a Calendar event only after the exact proposal is approved, and blocks replay", async () => {
    let calendarOwner = "";
    const connectionStore: GoogleCalendarConnectionStore = {
      connectCalendar: async () => { throw new Error("not used"); },
      async getConnection(userId) {
        calendarOwner = userId;
        return {
          id: randomUUID(), userId, providerSubject: "google-subject", email: "owner@example.test",
          status: "active", grantedScopes: [GoogleCalendarScope],
          connectedAt: new Date("2026-11-19T00:00:00.000Z"), disconnectedAt: null
        };
      },
      async getDecryptedRefreshToken() { return "refresh-token"; },
      async markReauthRequired() {},
      async disconnectCalendar() {}
    };
    const oauthClient: GoogleCalendarOAuthClient = {
      buildAuthorizationUrl: async () => new URL("https://accounts.google.com"),
      exchangeAuthorizationCode: async () => ({
        subject: "google-subject", email: "owner@example.test", emailVerified: true,
        refreshToken: "refresh-token", grantedScopes: [GoogleCalendarScope]
      }),
      refreshAccessToken: async () => ({ accessToken: "access-token", expiresInSeconds: 3600 }),
      revokeToken: async () => undefined
    };
    const createEventArguments: unknown[][] = [];
    const createEvent = vi.fn(async (
      accessToken: string,
      snapshot: CalendarEventSnapshot,
      idempotencyKey: string,
      signal: AbortSignal
    ) => {
      createEventArguments.push([accessToken, snapshot, idempotencyKey, signal]);
    });
    const runtime = new CalendarActionRuntime({
      enabled: true,
      connectionStore,
      oauthClient,
      calendarApi: { createEvent, reconcileEvent: vi.fn(async () => "unknown" as const) }
    });
    const { app, runId, emailId, ownerId } = createTestApp(runtime, runtime);
    const created = await authenticatedPost(app, {
      agentRunId: null,
      idempotencyKey: "cf16c880-a02c-43c0-88f2-0a32b625646b",
      actionType: "create_calendar_event",
      payload: {
        title: "Invoice review",
        startAt: "2027-02-01T04:30:00.000Z",
        endAt: "2027-02-01T05:30:00.000Z",
        startLocal: "2027-02-01T10:00",
        endLocal: "2027-02-01T11:00",
        timezone: "Asia/Kolkata",
        location: null,
        sourceEmailId: emailId
      },
      sourceEvidence: [{
        emailId,
        threadId: "gmail-thread-owner-1",
        sourceRevision: 3,
        quote: "Please review invoice 7314 today"
      }]
    });
    const proposalId = created.body.proposal.id as string;
    const payloadHash = created.body.proposal.payloadHash as string;

    const bypass = await authenticatedExecute(app, proposalId, payloadHash);
    expect(bypass.status).toBe(409);
    expect(createEvent).not.toHaveBeenCalled();

    const approved = await authenticatedDecision(app, proposalId, "approve", payloadHash);
    const executed = await authenticatedExecute(app, proposalId, payloadHash);
    const replay = await authenticatedExecute(app, proposalId, payloadHash);

    expect(approved.status).toBe(200);
    expect(executed.status).toBe(200);
    expect(executed.body.proposal.status).toBe("succeeded");
    expect(replay.status).toBe(409);
    expect(calendarOwner).toBe(ownerId);
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createEventArguments[0]).toEqual([
      "access-token",
      expect.objectContaining({ actionType: "create_calendar_event" }),
      expect.any(String),
      expect.any(AbortSignal)
    ]);
    expect(runId).toBeDefined();
  });

  it("blocks execution before approval and does not call the executor", async () => {
    let calls = 0;
    const executor: ActionExecutor = {
      async execute() { calls += 1; return { status: "succeeded" }; }
    };
    const { app, runId, emailId, store } = createTestApp(executor);
    const created = await authenticatedPost(app, validRequest(runId, emailId));

    const result = await authenticatedExecute(app, created.body.proposal.id, created.body.proposal.payloadHash);

    expect(result.status).toBe(409);
    expect(calls).toBe(0);
    expect(store.proposals[0]?.status).toBe("pending");
  });

  it("atomically claims execution so concurrent replays invoke the executor once", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    let notifyClaimed: (() => void) | undefined;
    const claimed = new Promise<void>((resolve) => { notifyClaimed = resolve; });
    const executor: ActionExecutor = {
      async execute() {
        calls += 1;
        notifyClaimed?.();
        return new Promise((resolve) => { release = () => resolve({ status: "succeeded" }); });
      }
    };
    const { app, runId, emailId } = createTestApp(executor);
    const created = await authenticatedPost(app, validRequest(runId, emailId));
    const proposalId = created.body.proposal.id as string;
    const payloadHash = created.body.proposal.payloadHash as string;
    await authenticatedDecision(app, proposalId, "approve", payloadHash);

    const firstPromise = authenticatedExecute(app, proposalId, payloadHash).then((response) => response);
    await claimed;
    const replay = await authenticatedExecute(app, proposalId, payloadHash);
    release?.();
    const first = await firstPromise;

    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
    expect(calls).toBe(1);
  });

  it("revalidates source evidence immediately before mock execution", async () => {
    const executorCalls: string[] = [];
    const executor: ActionExecutor = {
      async execute(snapshot) {
        executorCalls.push(snapshot.actionType);
        return { status: "succeeded" };
      }
    };
    const { app, runId, emailId, store } = createTestApp(executor);
    const created = await authenticatedPost(app, validRequest(runId, emailId));
    const proposalId = created.body.proposal.id as string;
    const payloadHash = created.body.proposal.payloadHash as string;
    await authenticatedDecision(app, proposalId, "approve", payloadHash);
    store.emails[0]!.sourceRevision += 1;

    const execution = await authenticatedExecute(app, proposalId, payloadHash);

    expect(execution.status).toBe(409);
    expect(execution.body.error.code).toBe("ACTION_EVIDENCE_STALE");
    expect(executorCalls).toEqual([]);
    expect(store.proposals[0]?.status).toBe("approved");
  });

  it("requires the owner to execute and rejects stale hashes", async () => {
    const executorCalls: string[] = [];
    const executor: ActionExecutor = {
      async execute(snapshot) {
        executorCalls.push(snapshot.actionType);
        return { status: "succeeded" };
      }
    };
    const { app, runId, emailId, store } = createTestApp(executor);
    const created = await authenticatedPost(app, validRequest(runId, emailId));
    const proposalId = created.body.proposal.id as string;
    const payloadHash = created.body.proposal.payloadHash as string;
    await authenticatedDecision(app, proposalId, "approve", payloadHash);

    const unauthorized = await authenticatedExecute(app, proposalId, payloadHash, OTHER_TOKEN, OTHER_CSRF);
    const stale = await authenticatedExecute(app, proposalId, "0".repeat(64));

    expect(unauthorized.status).toBe(404);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("ACTION_PROPOSAL_STALE");
    expect(executorCalls).toEqual([]);
    expect(store.proposals[0]?.status).toBe("approved");
  });

  it("requires reconciliation after an executor exception without exposing details", async () => {
    const executor: ActionExecutor = {
      async execute() {
        throw new Error("provider secrets must not be returned");
      }
    };
    const { app, runId, emailId, store } = createTestApp(executor);
    const created = await authenticatedPost(app, validRequest(runId, emailId));
    const proposalId = created.body.proposal.id as string;
    const payloadHash = created.body.proposal.payloadHash as string;
    await authenticatedDecision(app, proposalId, "approve", payloadHash);

    const execution = await authenticatedExecute(app, proposalId, payloadHash);

    expect(execution.status).toBe(200);
    expect(execution.body.proposal.status).toBe("reconciliation_required");
    expect(execution.body.proposal.execution.resultCode).toBe("EXECUTION_OUTCOME_UNKNOWN");
    expect(JSON.stringify(execution.body)).not.toContain("provider secrets");
    expect(store.auditEvents).toContain("action_proposal.reconciliation_required");
  });

  it("requires reconciliation after partial or uncertain external outcomes", async () => {
    for (const status of ["partial", "uncertain"] as const) {
      const executor: ActionExecutor = { async execute() { return { status }; } };
      const { app, runId, emailId, store } = createTestApp(executor);
      const created = await authenticatedPost(app, validRequest(runId, emailId));
      const proposalId = created.body.proposal.id as string;
      const payloadHash = created.body.proposal.payloadHash as string;
      await authenticatedDecision(app, proposalId, "approve", payloadHash);

      const result = await authenticatedExecute(app, proposalId, payloadHash);

      expect(result.body.proposal.status).toBe("reconciliation_required");
      expect(store.proposals[0]?.executionKey).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("aborts timed-out execution and blocks retry until the outcome is reconciled", async () => {
    let aborted = false;
    let calls = 0;
    const executor: ActionExecutor = {
      async execute(_snapshot, context) {
        calls += 1;
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
        });
      }
    };
    const { app, runId, emailId } = createTestApp(executor, undefined, 5);
    const created = await authenticatedPost(app, validRequest(runId, emailId));
    const proposalId = created.body.proposal.id as string;
    const payloadHash = created.body.proposal.payloadHash as string;
    await authenticatedDecision(app, proposalId, "approve", payloadHash);

    const timedOut = await authenticatedExecute(app, proposalId, payloadHash);
    const retry = await authenticatedExecute(app, proposalId, payloadHash);

    expect(timedOut.body.proposal.status).toBe("reconciliation_required");
    expect(timedOut.body.proposal.execution.resultCode).toBe("EXECUTION_TIMEOUT");
    expect(aborted).toBe(true);
    expect(retry.status).toBe(409);
    expect(calls).toBe(1);
  });

  it("allows retry only after reconciliation confirms no action occurred and reuses the key", async () => {
    const keys: string[] = [];
    let attempt = 0;
    const executor: ActionExecutor = {
      async execute(_snapshot, context) {
        keys.push(context.idempotencyKey);
        attempt += 1;
        return attempt === 1 ? { status: "uncertain" } : { status: "succeeded" };
      }
    };
    const reconciler: ActionReconciler = { async reconcile() { return "not_executed"; } };
    const { app, runId, emailId } = createTestApp(executor, reconciler);
    const created = await authenticatedPost(app, validRequest(runId, emailId));
    const proposalId = created.body.proposal.id as string;
    const payloadHash = created.body.proposal.payloadHash as string;
    await authenticatedDecision(app, proposalId, "approve", payloadHash);
    await authenticatedExecute(app, proposalId, payloadHash);

    const reconciled = await authenticatedReconcile(app, proposalId, payloadHash);
    expect(reconciled.body.proposal.status).toBe("approved");
    expect(reconciled.body.proposal.execution.resultCode).toBe("EXECUTION_NOT_PERFORMED_CONFIRMED");

    const retried = await authenticatedExecute(app, proposalId, payloadHash);
    expect(retried.body.proposal.status).toBe("succeeded");
    expect(retried.body.proposal.execution.attempts).toBe(2);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("keeps unknown reconciliation outcomes blocked and owner scoped", async () => {
    const executor: ActionExecutor = { async execute() { return { status: "partial" }; } };
    const reconciler: ActionReconciler = { async reconcile() { return "unknown"; } };
    const { app, runId, emailId, store } = createTestApp(executor, reconciler);
    const created = await authenticatedPost(app, validRequest(runId, emailId));
    const proposalId = created.body.proposal.id as string;
    const payloadHash = created.body.proposal.payloadHash as string;
    await authenticatedDecision(app, proposalId, "approve", payloadHash);
    await authenticatedExecute(app, proposalId, payloadHash);

    const unauthorized = await authenticatedReconcile(app, proposalId, payloadHash, OTHER_TOKEN, OTHER_CSRF);
    const unknown = await authenticatedReconcile(app, proposalId, payloadHash);
    const replay = await authenticatedExecute(app, proposalId, payloadHash);

    expect(unauthorized.status).toBe(404);
    expect(unknown.body.proposal.status).toBe("reconciliation_required");
    expect(replay.status).toBe(409);
    expect(store.auditEvents).toContain("action_proposal.reconciliation_checked");
  });

  it("allows only one concurrent reconciliation check", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    let notifyClaimed: (() => void) | undefined;
    const claimed = new Promise<void>((resolve) => { notifyClaimed = resolve; });
    const executor: ActionExecutor = { async execute() { return { status: "uncertain" }; } };
    const reconciler: ActionReconciler = {
      async reconcile() {
        calls += 1;
        notifyClaimed?.();
        return new Promise((resolve) => { release = () => resolve("unknown"); });
      }
    };
    const { app, runId, emailId } = createTestApp(executor, reconciler);
    const created = await authenticatedPost(app, validRequest(runId, emailId));
    const proposalId = created.body.proposal.id as string;
    const payloadHash = created.body.proposal.payloadHash as string;
    await authenticatedDecision(app, proposalId, "approve", payloadHash);
    await authenticatedExecute(app, proposalId, payloadHash);

    const firstPromise = authenticatedReconcile(app, proposalId, payloadHash).then((response) => response);
    await claimed;
    const duplicate = await authenticatedReconcile(app, proposalId, payloadHash);
    release?.();
    const first = await firstPromise;

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("ACTION_RECONCILIATION_IN_PROGRESS");
    expect(calls).toBe(1);
  });

  it("rejects caller-supplied owner and risk metadata", async () => {
    const { app, otherUserId, runId, emailId, store } = createTestApp();
    const body = { ...validRequest(runId, emailId), userId: otherUserId, riskLevel: "low" };

    const response = await authenticatedPost(app, body);

    expect(response.status).toBe(400);
    expect(store.proposals).toHaveLength(0);
  });

  it("rejects cross-user runs and source evidence", async () => {
    const { app, otherRunId, otherEmailId, runId, emailId, store } = createTestApp();
    const foreignRun = await authenticatedPost(app, validRequest(otherRunId, emailId));
    const foreignEmailBody = validRequest(runId, otherEmailId);
    foreignEmailBody.sourceEvidence[0]!.threadId = "gmail-thread-other-1";
    const foreignEmail = await authenticatedPost(app, foreignEmailBody);

    expect(foreignRun.status).toBe(404);
    expect(foreignEmail.status).toBe(404);
    expect(store.proposals).toHaveLength(0);
  });

  it("rejects evidence quotes that do not exist in the referenced message", async () => {
    const { app, runId, emailId, store } = createTestApp();
    const body = validRequest(runId, emailId);
    body.sourceEvidence[0]!.quote = "This exact sentence is not in the source message.";

    const response = await authenticatedPost(app, body);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("ACTION_EVIDENCE_STALE");
    expect(store.proposals).toHaveLength(0);
  });

  it("lists proposals only for the authenticated owner", async () => {
    const { app, runId, emailId, store } = createTestApp();
    const body = validRequest(runId, emailId);
    await authenticatedPost(app, body);

    const ownerList = await request(app)
      .get("/v1/actions/proposals")
      .set("Cookie", `mailpilot_session=${OWNER_TOKEN}`);
    const otherList = await request(app)
      .get("/v1/actions/proposals")
      .set("Cookie", `mailpilot_session=${OTHER_TOKEN}`);

    expect(ownerList.status).toBe(200);
    expect(ownerList.body.proposals).toHaveLength(1);
    expect(otherList.status).toBe(200);
    expect(otherList.body.proposals).toEqual([]);
    expect(store.proposals).toHaveLength(1);
  });

  it("returns the same proposal for an idempotent retry and rejects key reuse", async () => {
    const { app, runId, emailId, store } = createTestApp();
    const body = validRequest(runId, emailId);
    const first = await authenticatedPost(app, body);
    const retry = await authenticatedPost(app, body);
    const changed = await authenticatedPost(app, {
      ...body,
      payload: { ...body.payload, subject: "Different payload" }
    });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.proposal.id).toBe(first.body.proposal.id);
    expect(changed.status).toBe(409);
    expect(store.proposals).toHaveLength(1);
  });
});
