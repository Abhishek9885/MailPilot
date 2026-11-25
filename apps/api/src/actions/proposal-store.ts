import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import type { ActionProposalSnapshot } from "@mailpilot/shared";

export interface ProposalAgentRun {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
}

export interface ProposalSourceEmail {
  id: string;
  threadId: string;
  sourceRevision: number;
  subject: string;
  bodyText: string;
}

export type StoredActionStatus =
  | "pending" | "approved" | "rejected" | "executing" | "succeeded" | "failed"
  | "reconciliation_required" | "expired" | "cancelled";

export interface ActionProposalRecord {
  id: string;
  userId: string;
  agentRunId: string | null;
  idempotencyKey: string;
  actionType: string;
  canonicalPayload: unknown;
  payloadHash: string;
  status: StoredActionStatus;
  executionKey: string | null;
  executionStartedAt: Date | null;
  executionLeaseExpiresAt: Date | null;
  executionAttempts: number;
  executionResultCode: string | null;
  reconciliationClaimId: string | null;
  reconciliationLeaseExpiresAt: Date | null;
  reconciliationAttempts: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface CreateActionProposalRecord {
  userId: string;
  agentRunId: string | null;
  idempotencyKey: string;
  actionType: string;
  snapshot: ActionProposalSnapshot;
  payloadHash: string;
  createdAt: Date;
  expiresAt: Date;
  requestId: string | null;
}

export interface TransitionActionProposalRecord {
  userId: string;
  proposalId: string;
  expectedPayloadHash: string;
  fromStatus: StoredActionStatus;
  toStatus: StoredActionStatus;
  now: Date;
  requireUnexpired: boolean;
  setDecidedAt: boolean;
  actorType: "user" | "system";
  requestId: string | null;
  executionMode?: "mock" | "provider";
  expectedExecutionKey?: string | null;
  setExecutionKey?: string;
  executionStartedAt?: Date | null;
  executionLeaseExpiresAt?: Date | null;
  incrementExecutionAttempts?: boolean;
  executionResultCode?: string | null;
  expectedReconciliationClaimId?: string;
}

export interface ActionProposalStore {
  findAgentRun(userId: string, agentRunId: string): Promise<ProposalAgentRun | null>;
  findSourceEmails(userId: string, emailIds: string[]): Promise<ProposalSourceEmail[]>;
  findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<ActionProposalRecord | null>;
  findById(userId: string, proposalId: string): Promise<ActionProposalRecord | null>;
  createProposal(input: CreateActionProposalRecord): Promise<ActionProposalRecord>;
  transitionProposal(input: TransitionActionProposalRecord): Promise<ActionProposalRecord | null>;
  expireDue(userId: string, now: Date, requestId?: string | null): Promise<void>;
  reconcileExpiredExecutions(userId: string, now: Date, requestId?: string | null): Promise<void>;
  claimReconciliation(
    userId: string,
    proposalId: string,
    payloadHash: string,
    claimId: string,
    now: Date,
    leaseExpiresAt: Date,
    requestId: string | null
  ): Promise<boolean>;
  releaseReconciliation(
    userId: string,
    proposalId: string,
    payloadHash: string,
    claimId: string,
    requestId: string | null,
    now: Date
  ): Promise<void>;
  listProposals(userId: string, limit: number): Promise<ActionProposalRecord[]>;
}

export class PrismaActionProposalStore implements ActionProposalStore {
  public constructor(private readonly database: PrismaClient) {}

  public async findAgentRun(userId: string, agentRunId: string): Promise<ProposalAgentRun | null> {
    return this.database.agentRun.findUnique({
      where: { userId_id: { userId, id: agentRunId } },
      select: { id: true, status: true }
    });
  }

  public async findSourceEmails(userId: string, emailIds: string[]): Promise<ProposalSourceEmail[]> {
    if (emailIds.length === 0) return [];
    const records = await this.database.email.findMany({
      where: { userId, id: { in: emailIds }, deletedAt: null },
      select: { id: true, providerThreadId: true, sourceRevision: true, subject: true, bodyText: true }
    });
    return records.map((record) => ({
      id: record.id,
      threadId: record.providerThreadId,
      sourceRevision: record.sourceRevision,
      subject: record.subject,
      bodyText: record.bodyText
    }));
  }

  public async findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<ActionProposalRecord | null> {
    const record = await this.database.pendingAction.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } }
    });
    return record ? mapRecord(record) : null;
  }

  public async findById(userId: string, proposalId: string): Promise<ActionProposalRecord | null> {
    const record = await this.database.pendingAction.findFirst({ where: { id: proposalId, userId } });
    return record ? mapRecord(record) : null;
  }

  public async createProposal(input: CreateActionProposalRecord): Promise<ActionProposalRecord> {
    try {
      const record = await this.database.$transaction(async (transaction) => {
        const proposal = await transaction.pendingAction.create({
          data: {
            userId: input.userId,
            agentRunId: input.agentRunId,
            idempotencyKey: input.idempotencyKey,
            actionType: input.actionType,
            canonicalPayload: input.snapshot as unknown as Prisma.InputJsonValue,
            payloadHash: input.payloadHash,
            payloadVersion: 1,
            status: "pending",
            createdAt: input.createdAt,
            expiresAt: input.expiresAt
          }
        });
        await transaction.auditLog.create({
          data: {
            userId: input.userId,
            actorType: "user",
            eventType: "action_proposal.created",
            entityType: "pending_action",
            entityId: proposal.id,
            requestId: input.requestId,
            metadata: { actionType: input.actionType, payloadHash: input.payloadHash, status: "pending" }
          }
        });
        return proposal;
      });
      return mapRecord(record);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.findByIdempotencyKey(input.userId, input.idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    }
  }

  public async transitionProposal(input: TransitionActionProposalRecord): Promise<ActionProposalRecord | null> {
    return this.database.$transaction(async (transaction) => {
      const changed = await transaction.pendingAction.updateMany({
        where: {
          id: input.proposalId,
          userId: input.userId,
          status: input.fromStatus,
          payloadHash: input.expectedPayloadHash,
          ...(input.expectedExecutionKey !== undefined ? { executionKey: input.expectedExecutionKey } : {}),
          ...(input.expectedReconciliationClaimId ? {
            reconciliationClaimId: input.expectedReconciliationClaimId,
            reconciliationLeaseExpiresAt: { gt: input.now }
          } : {}),
          ...(input.requireUnexpired ? { expiresAt: { gt: input.now } } : {})
        },
        data: {
          status: input.toStatus,
          updatedAt: input.now,
          ...(input.setDecidedAt ? { decidedAt: input.now } : {}),
          ...(input.setExecutionKey ? { executionKey: input.setExecutionKey } : {}),
          ...(input.executionStartedAt !== undefined ? { executionStartedAt: input.executionStartedAt } : {}),
          ...(input.executionLeaseExpiresAt !== undefined
            ? { executionLeaseExpiresAt: input.executionLeaseExpiresAt }
            : {}),
          ...(input.incrementExecutionAttempts ? { executionAttempts: { increment: 1 } } : {}),
          ...(input.executionResultCode !== undefined ? { executionResultCode: input.executionResultCode } : {}),
          ...(input.expectedReconciliationClaimId
            ? { reconciliationClaimId: null, reconciliationLeaseExpiresAt: null }
            : {})
        }
      });
      if (changed.count !== 1) return null;

      const record = await transaction.pendingAction.findFirst({ where: { id: input.proposalId, userId: input.userId } });
      if (!record) return null;
      await transaction.auditLog.create({
        data: {
          userId: input.userId,
          actorType: input.actorType,
          eventType: `action_proposal.${input.toStatus}`,
          entityType: "pending_action",
          entityId: input.proposalId,
          requestId: input.requestId,
          metadata: {
            actionType: record.actionType,
            payloadHash: input.expectedPayloadHash,
            fromStatus: input.fromStatus,
            toStatus: input.toStatus,
            executionAttempts: record.executionAttempts,
            ...(input.executionMode ? { executionMode: input.executionMode } : {}),
            ...(record.executionResultCode ? { resultCode: record.executionResultCode } : {})
          }
        }
      });
      return mapRecord(record);
    });
  }

  public async expireDue(userId: string, now: Date, requestId: string | null = null): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const due = await transaction.pendingAction.findMany({
        where: { userId, status: { in: ["pending", "approved"] }, expiresAt: { lte: now } },
        select: { id: true, status: true, actionType: true, payloadHash: true }
      });
      for (const proposal of due) {
        const changed = await transaction.pendingAction.updateMany({
          where: { id: proposal.id, userId, status: proposal.status, expiresAt: { lte: now } },
          data: { status: "expired", updatedAt: now, ...(proposal.status === "pending" ? { decidedAt: now } : {}) }
        });
        if (changed.count !== 1) continue;
        await transaction.auditLog.create({
          data: {
            userId,
            actorType: "system",
            eventType: "action_proposal.expired",
            entityType: "pending_action",
            entityId: proposal.id,
            requestId,
            metadata: {
              actionType: proposal.actionType,
              payloadHash: proposal.payloadHash,
              fromStatus: proposal.status,
              toStatus: "expired"
            }
          }
        });
      }
    });
  }

  public async reconcileExpiredExecutions(userId: string, now: Date, requestId: string | null = null): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const overdue = await transaction.pendingAction.findMany({
        where: { userId, status: "executing", executionLeaseExpiresAt: { lte: now } },
        select: { id: true, actionType: true, payloadHash: true }
      });
      for (const proposal of overdue) {
        const changed = await transaction.pendingAction.updateMany({
          where: {
            id: proposal.id,
            userId,
            status: "executing",
            executionLeaseExpiresAt: { lte: now }
          },
          data: {
            status: "reconciliation_required",
            executionLeaseExpiresAt: null,
            executionResultCode: "EXECUTION_LEASE_EXPIRED",
            updatedAt: now
          }
        });
        if (changed.count !== 1) continue;
        await transaction.auditLog.create({
          data: {
            userId,
            actorType: "system",
            eventType: "action_proposal.reconciliation_required",
            entityType: "pending_action",
            entityId: proposal.id,
            requestId,
            metadata: {
              actionType: proposal.actionType,
              payloadHash: proposal.payloadHash,
              fromStatus: "executing",
              toStatus: "reconciliation_required",
              resultCode: "EXECUTION_LEASE_EXPIRED"
            }
          }
        });
      }
    });
  }

  public async claimReconciliation(
    userId: string,
    proposalId: string,
    payloadHash: string,
    claimId: string,
    now: Date,
    leaseExpiresAt: Date,
    requestId: string | null
  ): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const claimed = await transaction.pendingAction.updateMany({
        where: {
          id: proposalId,
          userId,
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
      if (claimed.count !== 1) return false;
      const proposal = await transaction.pendingAction.findFirst({
        where: { id: proposalId, userId },
        select: { reconciliationAttempts: true }
      });
      await transaction.auditLog.create({
        data: {
          userId,
          actorType: "system",
          eventType: "action_proposal.reconciliation_claimed",
          entityType: "pending_action",
          entityId: proposalId,
          requestId,
          metadata: { payloadHash, reconciliationAttempt: proposal?.reconciliationAttempts ?? 0 }
        }
      });
      return true;
    });
  }

  public async releaseReconciliation(
    userId: string,
    proposalId: string,
    payloadHash: string,
    claimId: string,
    requestId: string | null,
    now: Date
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const changed = await transaction.pendingAction.updateMany({
        where: {
          id: proposalId,
          userId,
          payloadHash,
          status: "reconciliation_required",
          reconciliationClaimId: claimId
        },
        data: { reconciliationClaimId: null, reconciliationLeaseExpiresAt: null, updatedAt: now }
      });
      if (changed.count !== 1) return;
      const proposal = await transaction.pendingAction.findFirst({
        where: { id: proposalId, userId },
        select: { actionType: true, executionAttempts: true }
      });
      if (!proposal) return;
      await transaction.auditLog.create({
        data: {
          userId,
          actorType: "system",
          eventType: "action_proposal.reconciliation_checked",
          entityType: "pending_action",
          entityId: proposalId,
          requestId,
          metadata: {
            actionType: proposal.actionType,
            payloadHash,
            executionAttempts: proposal.executionAttempts,
            resultCode: "RECONCILIATION_OUTCOME_UNKNOWN"
          }
        }
      });
    });
  }

  public async listProposals(userId: string, limit: number): Promise<ActionProposalRecord[]> {
    const records = await this.database.pendingAction.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: limit
    });
    return records.map(mapRecord);
  }
}

function mapRecord(record: {
  id: string;
  userId: string;
  agentRunId: string | null;
  idempotencyKey: string;
  actionType: string;
  canonicalPayload: Prisma.JsonValue;
  payloadHash: string;
  status: StoredActionStatus;
  executionKey: string | null;
  executionStartedAt: Date | null;
  executionLeaseExpiresAt: Date | null;
  executionAttempts: number;
  executionResultCode: string | null;
  reconciliationClaimId: string | null;
  reconciliationLeaseExpiresAt: Date | null;
  reconciliationAttempts: number;
  createdAt: Date;
  expiresAt: Date;
}): ActionProposalRecord {
  return {
    id: record.id,
    userId: record.userId,
    agentRunId: record.agentRunId,
    idempotencyKey: record.idempotencyKey,
    actionType: record.actionType,
    canonicalPayload: record.canonicalPayload,
    payloadHash: record.payloadHash,
    status: record.status,
    executionKey: record.executionKey,
    executionStartedAt: record.executionStartedAt,
    executionLeaseExpiresAt: record.executionLeaseExpiresAt,
    executionAttempts: record.executionAttempts,
    executionResultCode: record.executionResultCode,
    reconciliationClaimId: record.reconciliationClaimId,
    reconciliationLeaseExpiresAt: record.reconciliationLeaseExpiresAt,
    reconciliationAttempts: record.reconciliationAttempts,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt
  };
}
