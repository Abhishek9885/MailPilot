import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaActionProposalStore } from "../src/actions/proposal-store.js";

const USER_ID = "3d5e8475-42cc-4373-8bd0-f7ba82cb8339";
const RUN_ID = "596f21a1-e643-4cb9-a5c7-e2c7d95025c5";
const EMAIL_ID = "f0b24881-64bb-43be-9668-4caf619ea777";

describe("Prisma action proposal data access", () => {
  it("scopes workflow ownership lookups to the authenticated user", async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: RUN_ID, status: "completed" });
    const database = { agentRun: { findUnique } } as unknown as PrismaClient;
    const store = new PrismaActionProposalStore(database);

    await store.findAgentRun(USER_ID, RUN_ID);

    expect(findUnique).toHaveBeenCalledWith({
      where: { userId_id: { userId: USER_ID, id: RUN_ID } },
      select: { id: true, status: true }
    });
  });

  it("scopes source messages and excludes deleted records", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const database = { email: { findMany } } as unknown as PrismaClient;
    const store = new PrismaActionProposalStore(database);

    await store.findSourceEmails(USER_ID, [EMAIL_ID]);

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, id: { in: [EMAIL_ID] }, deletedAt: null },
      select: {
        id: true,
        providerThreadId: true,
        sourceRevision: true,
        subject: true,
        bodyText: true
      }
    });
  });

  it("scopes proposal idempotency and listing by owner", async () => {
    const proposalFindUnique = vi.fn().mockResolvedValue(null);
    const proposalFindMany = vi.fn().mockResolvedValue([]);
    const database = {
      pendingAction: { findUnique: proposalFindUnique, findMany: proposalFindMany }
    } as unknown as PrismaClient;
    const store = new PrismaActionProposalStore(database);
    const idempotencyKey = "c2b85a77-9925-4743-8b2b-2a77ec5adf4f";

    await store.findByIdempotencyKey(USER_ID, idempotencyKey);
    await store.listProposals(USER_ID, 100);

    expect(proposalFindUnique).toHaveBeenCalledWith({
      where: { userId_idempotencyKey: { userId: USER_ID, idempotencyKey } }
    });
    expect(proposalFindMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: 100
    });
  });

  it("uses an owner, status, payload-hash, and expiry compare-and-set for approval", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const database = {
      $transaction: vi.fn(async (work: (transaction: unknown) => unknown) => work({
        pendingAction: { updateMany },
        auditLog: { create: vi.fn() }
      }))
    } as unknown as PrismaClient;
    const store = new PrismaActionProposalStore(database);
    const proposalId = "2f574399-a6b1-46ea-a31d-242124706bcf";
    const payloadHash = "a".repeat(64);
    const now = new Date("2026-11-19T10:00:00.000Z");

    await store.transitionProposal({
      userId: USER_ID,
      proposalId,
      expectedPayloadHash: payloadHash,
      fromStatus: "pending",
      toStatus: "approved",
      now,
      requireUnexpired: true,
      setDecidedAt: true,
      actorType: "user",
      requestId: "request-approval-test"
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: proposalId,
        userId: USER_ID,
        status: "pending",
        payloadHash,
        expiresAt: { gt: now }
      },
      data: { status: "approved", updatedAt: now, decidedAt: now }
    });
  });

  it("expires only due pending and approved proposals for that owner", async () => {
    const pendingFindMany = vi.fn().mockResolvedValue([]);
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const database = {
      $transaction: vi.fn(async (work: (transaction: unknown) => unknown) => work({
        pendingAction: { findMany: pendingFindMany, updateMany },
        auditLog: { create: vi.fn() }
      }))
    } as unknown as PrismaClient;
    const store = new PrismaActionProposalStore(database);
    const now = new Date("2026-11-20T10:00:00.000Z");

    await store.expireDue(USER_ID, now);

    expect(pendingFindMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, status: { in: ["pending", "approved"] }, expiresAt: { lte: now } },
      select: { id: true, status: true, actionType: true, payloadHash: true }
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("atomically leases reconciliation to one owner-scoped caller", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findFirst = vi.fn().mockResolvedValue({ reconciliationAttempts: 2 });
    const auditCreate = vi.fn().mockResolvedValue({ id: "audit-id" });
    const database = {
      $transaction: vi.fn(async (work: (transaction: unknown) => unknown) => work({
        pendingAction: { updateMany, findFirst },
        auditLog: { create: auditCreate }
      }))
    } as unknown as PrismaClient;
    const store = new PrismaActionProposalStore(database);
    const proposalId = "2f574399-a6b1-46ea-a31d-242124706bcf";
    const payloadHash = "a".repeat(64);
    const claimId = "2c6a1047-8ebf-49c2-9a73-aacb1b314bd9";
    const now = new Date("2026-11-19T10:00:00.000Z");
    const leaseExpiresAt = new Date("2026-11-19T10:00:15.000Z");

    const claimed = await store.claimReconciliation(
      USER_ID, proposalId, payloadHash, claimId, now, leaseExpiresAt, "request-reconcile-test"
    );

    expect(claimed).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: proposalId,
        userId: USER_ID,
        payloadHash,
        status: "reconciliation_required",
        OR: [
          { reconciliationLeaseExpiresAt: null },
          { reconciliationLeaseExpiresAt: { lte: now } }
        ]
      },
      data: {
        reconciliationClaimId: claimId,
        reconciliationLeaseExpiresAt: leaseExpiresAt,
        reconciliationAttempts: { increment: 1 },
        updatedAt: now
      }
    });
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: USER_ID,
        eventType: "action_proposal.reconciliation_claimed",
        entityId: proposalId,
        requestId: "request-reconcile-test"
      })
    }));
  });

  it("releases only the matching reconciliation lease and audits unknown outcomes", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findFirst = vi.fn().mockResolvedValue({ actionType: "send_email", executionAttempts: 1 });
    const auditCreate = vi.fn().mockResolvedValue({ id: "audit-id" });
    const database = {
      $transaction: vi.fn(async (work: (transaction: unknown) => unknown) => work({
        pendingAction: { updateMany, findFirst },
        auditLog: { create: auditCreate }
      }))
    } as unknown as PrismaClient;
    const store = new PrismaActionProposalStore(database);
    const proposalId = "2f574399-a6b1-46ea-a31d-242124706bcf";
    const payloadHash = "a".repeat(64);
    const claimId = "2c6a1047-8ebf-49c2-9a73-aacb1b314bd9";
    const now = new Date("2026-11-19T10:00:00.000Z");

    await store.releaseReconciliation(USER_ID, proposalId, payloadHash, claimId, "request-reconcile-test", now);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: proposalId,
        userId: USER_ID,
        payloadHash,
        status: "reconciliation_required",
        reconciliationClaimId: claimId
      },
      data: { reconciliationClaimId: null, reconciliationLeaseExpiresAt: null, updatedAt: now }
    });
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: USER_ID,
        eventType: "action_proposal.reconciliation_checked",
        entityId: proposalId,
        metadata: expect.objectContaining({ resultCode: "RECONCILIATION_OUTCOME_UNKNOWN" })
      })
    }));
  });

  it("writes audit rows in the same transaction as owner-scoped transitions", async () => {
    const payloadHash = "a".repeat(64);
    const createdAt = new Date("2026-11-19T10:00:00.000Z");
    const expiresAt = new Date("2026-11-20T10:00:00.000Z");
    const snapshot = {
      schemaVersion: "action-proposal-v1",
      userId: USER_ID,
      agentRunId: RUN_ID,
      idempotencyKey: "c2b85a77-9925-4743-8b2b-2a77ec5adf4f",
      actionType: "send_email",
      payload: {
        to: ["recipient@example.com"],
        cc: [],
        bcc: [],
        subject: "Invoice",
        bodyText: "Please review the invoice.",
        replyToEmailId: EMAIL_ID
      },
      sourceEvidence: [{
        emailId: EMAIL_ID,
        threadId: "thread-7314",
        sourceRevision: 1,
        quote: "Please review invoice 7314."
      }],
      riskLevel: "high",
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    const record = {
      id: "2f574399-a6b1-46ea-a31d-242124706bcf",
      userId: USER_ID,
      agentRunId: RUN_ID,
      idempotencyKey: snapshot.idempotencyKey,
      actionType: "send_email",
      canonicalPayload: snapshot,
      payloadHash,
      status: "approved",
      createdAt,
      expiresAt
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findFirst = vi.fn().mockResolvedValue(record);
    const auditCreate = vi.fn().mockResolvedValue({ id: "audit-id" });
    const transaction = {
      pendingAction: { updateMany, findFirst },
      auditLog: { create: auditCreate }
    };
    const transactionRunner = vi.fn(async (work: (tx: typeof transaction) => unknown) => work(transaction));
    const store = new PrismaActionProposalStore({ $transaction: transactionRunner } as unknown as PrismaClient);
    const now = new Date("2026-11-19T11:00:00.000Z");

    const result = await store.transitionProposal({
      userId: USER_ID,
      proposalId: record.id,
      expectedPayloadHash: payloadHash,
      fromStatus: "pending",
      toStatus: "approved",
      now,
      requireUnexpired: true,
      setDecidedAt: true,
      actorType: "user",
      requestId: "request-approval-test"
    });

    expect(result?.status).toBe("approved");
    expect(auditCreate).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        actorType: "user",
        eventType: "action_proposal.approved",
        entityType: "pending_action",
        entityId: record.id,
        requestId: "request-approval-test",
        metadata: {
          actionType: "send_email",
          payloadHash,
          fromStatus: "pending",
          toStatus: "approved"
        }
      }
    });
  });

  it("writes a creation audit row atomically with the pending snapshot", async () => {
    const createdAt = new Date("2026-11-19T10:00:00.000Z");
    const expiresAt = new Date("2026-11-20T10:00:00.000Z");
    const snapshot = {
      schemaVersion: "action-proposal-v1" as const,
      userId: USER_ID,
      agentRunId: RUN_ID,
      idempotencyKey: "c2b85a77-9925-4743-8b2b-2a77ec5adf4f",
      actionType: "send_email" as const,
      payload: {
        to: ["recipient@example.com"],
        cc: [],
        bcc: [],
        subject: "Invoice",
        bodyText: "Please review the invoice.",
        replyToEmailId: EMAIL_ID
      },
      sourceEvidence: [{
        emailId: EMAIL_ID,
        threadId: "thread-7314",
        sourceRevision: 1,
        quote: "Please review invoice 7314."
      }],
      riskLevel: "high" as const,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    const record = {
      id: "2f574399-a6b1-46ea-a31d-242124706bcf",
      userId: USER_ID,
      agentRunId: RUN_ID,
      idempotencyKey: snapshot.idempotencyKey,
      actionType: "send_email",
      canonicalPayload: snapshot,
      payloadHash: "a".repeat(64),
      status: "pending",
      createdAt,
      expiresAt
    };
    const create = vi.fn().mockResolvedValue(record);
    const auditCreate = vi.fn().mockResolvedValue({ id: "audit-id" });
    const transaction = { pendingAction: { create }, auditLog: { create: auditCreate } };
    const transactionRunner = vi.fn(async (work: (tx: typeof transaction) => unknown) => work(transaction));
    const store = new PrismaActionProposalStore({ $transaction: transactionRunner } as unknown as PrismaClient);

    await store.createProposal({
      userId: USER_ID,
      agentRunId: RUN_ID,
      idempotencyKey: snapshot.idempotencyKey,
      actionType: "send_email",
      snapshot,
      payloadHash: record.payloadHash,
      createdAt,
      expiresAt,
      requestId: "request-create-test"
    });

    expect(auditCreate).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        actorType: "user",
        eventType: "action_proposal.created",
        entityType: "pending_action",
        entityId: record.id,
        requestId: "request-create-test",
        metadata: { actionType: "send_email", payloadHash: record.payloadHash, status: "pending" }
      }
    });
  });
});
