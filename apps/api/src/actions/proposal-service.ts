import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ActionProposalDecisionRequestSchema,
  ActionProposalSchema,
  ActionProposalSnapshotSchema,
  ActionProposalSchemaVersion,
  CreateActionProposalRequestSchema,
  type ActionProposal,
  type ActionProposalSnapshot,
  type CreateActionProposalRequest
} from "@mailpilot/shared";
import { MockActionReconciler, type ActionReconciler, type ReconciliationResult } from "./executor.js";
import { ApiError } from "../errors.js";
import { MockActionExecutor, type ActionExecutor } from "./executor.js";
import type { ActionProposalRecord, ActionProposalStore } from "./proposal-store.js";

const PROPOSAL_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_PROPOSALS = 100;
const DEFAULT_EXECUTION_TIMEOUT_MS = 15_000;
const EXECUTION_LEASE_GRACE_MS = 60_000;

export class ActionProposalService {
  private readonly now: () => Date;

  public constructor(
    private readonly store: ActionProposalStore,
    clock: () => Date = () => new Date(),
    private readonly executor: ActionExecutor = new MockActionExecutor(),
    private readonly reconciler: ActionReconciler = new MockActionReconciler(),
    private readonly executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS
  ) {
    this.now = clock;
  }

  public async create(userId: string, untrustedBody: unknown, requestId: string | null = null): Promise<ActionProposal> {
    const parsed = CreateActionProposalRequestSchema.safeParse(untrustedBody);
    if (!parsed.success) throw invalidProposalRequest();
    const request = parsed.data;

    const existing = await this.store.findByIdempotencyKey(userId, request.idempotencyKey);
    if (existing) return this.returnIdempotentOrConflict(existing, userId, request);

    if (request.agentRunId !== null) {
      const agentRun = await this.store.findAgentRun(userId, request.agentRunId);
      if (!agentRun) throw actionContextNotFound();
      if (agentRun.status !== "completed") {
        throw new ApiError(409, "ACTION_RUN_NOT_COMPLETE", "Finish the source workflow before proposing an action");
      }
    } else if (request.actionType !== "create_calendar_event") {
      throw actionContextNotFound();
    }
    await this.validateSourceEvidence(userId, request);

    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + PROPOSAL_LIFETIME_MS);
    const snapshot = ActionProposalSnapshotSchema.parse({
      schemaVersion: ActionProposalSchemaVersion,
      userId,
      agentRunId: request.agentRunId,
      idempotencyKey: request.idempotencyKey,
      actionType: request.actionType,
      payload: request.payload,
      sourceEvidence: request.sourceEvidence,
      riskLevel: riskForAction(request.actionType),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    });
    const payloadHash = hashSnapshot(snapshot);
    const record = await this.store.createProposal({
      userId,
      agentRunId: request.agentRunId,
      idempotencyKey: request.idempotencyKey,
      actionType: request.actionType,
      snapshot,
      payloadHash,
      createdAt,
      expiresAt,
      requestId
    });

    return this.returnIdempotentOrConflict(record, userId, request);
  }

  public async list(userId: string, requestId: string | null = null): Promise<ActionProposal[]> {
    const now = this.now();
    await this.store.reconcileExpiredExecutions(userId, now, requestId);
    await this.store.expireDue(userId, now, requestId);
    const records = await this.store.listProposals(userId, MAX_PROPOSALS);
    return records.map((record) => toProposal(record, now));
  }

  public approve(
    userId: string,
    untrustedProposalId: string,
    untrustedBody: unknown,
    requestId: string | null = null
  ): Promise<ActionProposal> {
    const payloadHash = parseDecisionHash(untrustedBody);
    return this.transition(userId, untrustedProposalId, payloadHash, "pending", "approved", "user", requestId);
  }

  public reject(
    userId: string,
    untrustedProposalId: string,
    untrustedBody: unknown,
    requestId: string | null = null
  ): Promise<ActionProposal> {
    const payloadHash = parseDecisionHash(untrustedBody);
    return this.transition(userId, untrustedProposalId, payloadHash, "pending", "rejected", "user", requestId);
  }

  /** Revalidates the approved immutable snapshot and source before invoking the configured executor. */
  public async executeApproved(
    userId: string,
    untrustedProposalId: string,
    untrustedBody: unknown,
    requestId: string | null = null
  ): Promise<ActionProposal> {
    const payloadHash = parseDecisionHash(untrustedBody);
    const proposalId = z.uuid().safeParse(untrustedProposalId);
    if (!proposalId.success) throw proposalNotFound();

    const now = this.now();
    await this.store.reconcileExpiredExecutions(userId, now, requestId);

    const current = await this.store.findById(userId, proposalId.data);
    if (!current) throw proposalNotFound();
    const proposal = toProposal(current, this.now());
    if (proposal.payloadHash !== payloadHash) throw staleProposal();
    if (proposal.status === "expired") {
      await this.store.expireDue(userId, this.now(), requestId);
      throw proposalExpired();
    }
    if (proposal.status !== "approved") {
      if (proposal.status === "reconciliation_required") throw reconciliationRequired();
      if (proposal.status === "executing" || proposal.status === "succeeded" || proposal.status === "failed") {
        throw duplicateTransition();
      }
      throw invalidTransition();
    }

    await this.validateSnapshotEvidence(userId, proposal.snapshot);
    const executionKey = createExecutionKey(proposal.id, proposal.payloadHash);
    if (current.executionKey !== null && current.executionKey !== executionKey) throw proposalIntegrityError();
    const startedAt = this.now();
    const executing = await this.transition(
      userId,
      proposalId.data,
      payloadHash,
      "approved",
      "executing",
      "user",
      requestId,
      {
        executionMode: proposal.snapshot.actionType === "create_calendar_event" ? "provider" : "mock",
        expectedExecutionKey: current.executionKey,
        ...(current.executionKey === null ? { setExecutionKey: executionKey } : {}),
        executionStartedAt: startedAt,
        executionLeaseExpiresAt: new Date(startedAt.getTime() + this.executionTimeoutMs + EXECUTION_LEASE_GRACE_MS),
        incrementExecutionAttempts: true,
        executionResultCode: null
      }
    );

    const controller = new AbortController();
    const outcome = await this.executeWithTimeout(executing.snapshot, userId, executionKey, controller);
    const toStatus = outcome.status === "succeeded" || outcome.status === "failed" ? outcome.status : "reconciliation_required";
    const resultCode = outcome.resultCode ?? executionResultCode(outcome.status);
    return this.transition(
      userId,
      proposalId.data,
      payloadHash,
      "executing",
      toStatus,
      "system",
      requestId,
      {
        executionMode: executing.snapshot.actionType === "create_calendar_event" ? "provider" : "mock",
        expectedExecutionKey: executionKey,
        executionLeaseExpiresAt: null,
        executionResultCode: resultCode
      }
    );
  }

  /** Only a confirmed no-effect result makes a retry possible, and it still requires the owner's approved action. */
  public async reconcile(
    userId: string,
    untrustedProposalId: string,
    untrustedBody: unknown,
    requestId: string | null = null
  ): Promise<ActionProposal> {
    const payloadHash = parseDecisionHash(untrustedBody);
    const proposalId = z.uuid().safeParse(untrustedProposalId);
    if (!proposalId.success) throw proposalNotFound();
    const now = this.now();
    await this.store.reconcileExpiredExecutions(userId, now, requestId);
    const current = await this.store.findById(userId, proposalId.data);
    if (!current) throw proposalNotFound();
    const proposal = toProposal(current, now);
    if (proposal.payloadHash !== payloadHash) throw staleProposal();
    if (proposal.status !== "reconciliation_required" || !current.executionKey) {
      if (proposal.status === "executing") throw executionStillInProgress();
      throw invalidTransition();
    }

    const claimId = randomUUID();
    const claimTime = this.now();
    const claimed = await this.store.claimReconciliation(
      userId,
      proposalId.data,
      payloadHash,
      claimId,
      claimTime,
      new Date(claimTime.getTime() + this.executionTimeoutMs + EXECUTION_LEASE_GRACE_MS),
      requestId
    );
    if (!claimed) throw reconciliationInProgress();

    const result: ReconciliationResult = await this.reconcileWithTimeout(proposal.snapshot, userId, current.executionKey);

    if (result === "unknown") {
      await this.store.releaseReconciliation(userId, proposalId.data, payloadHash, claimId, requestId, this.now());
      return proposal;
    }
    let toStatus: ActionProposal["status"];
    let resultCode: string;
    if (result === "succeeded") {
      toStatus = "succeeded";
      resultCode = "RECONCILED_SUCCEEDED";
    } else if (result === "failed") {
      toStatus = "failed";
      resultCode = "RECONCILED_FAILED_CONFIRMED";
    } else if (current.expiresAt.getTime() <= now.getTime()) {
      toStatus = "expired";
      resultCode = "EXECUTION_NOT_PERFORMED_EXPIRED";
    } else {
      toStatus = "approved";
      resultCode = "EXECUTION_NOT_PERFORMED_CONFIRMED";
    }
    return this.transition(
      userId,
      proposalId.data,
      payloadHash,
      "reconciliation_required",
      toStatus,
      "system",
      requestId,
      {
        expectedExecutionKey: current.executionKey,
        expectedReconciliationClaimId: claimId,
        executionResultCode: resultCode
      }
    );
  }

  private async executeWithTimeout(
    snapshot: ActionProposalSnapshot,
    userId: string,
    executionKey: string,
    controller: AbortController
  ): Promise<{
    status: "succeeded" | "failed" | "partial" | "uncertain" | "timeout";
    resultCode: string | null;
  }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const execution = this.executor.execute(snapshot, { userId, idempotencyKey: executionKey, signal: controller.signal })
      .then((result) => ({ status: result.status, resultCode: result.resultCode ?? null }))
      .catch(() => ({ status: "uncertain" as const, resultCode: null }));
    try {
      return await Promise.race([
        execution,
        new Promise<{ status: "timeout"; resultCode: string }>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ status: "timeout", resultCode: "EXECUTION_TIMEOUT" });
          }, this.executionTimeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async reconcileWithTimeout(
    snapshot: ActionProposalSnapshot,
    userId: string,
    executionKey: string
  ): Promise<ReconciliationResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reconciliation = this.reconciler.reconcile(snapshot, {
      userId,
      idempotencyKey: executionKey,
      signal: controller.signal
    }).catch(() => "unknown" as const);
    try {
      return await Promise.race([
        reconciliation,
        new Promise<"unknown">((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve("unknown");
          }, this.executionTimeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async validateSourceEvidence(userId: string, request: CreateActionProposalRequest): Promise<void> {
    await this.validateEvidence(userId, request.sourceEvidence);
  }

  private async validateSnapshotEvidence(userId: string, snapshot: ActionProposalSnapshot): Promise<void> {
    await this.validateEvidence(userId, snapshot.sourceEvidence);
  }

  private async validateEvidence(
    userId: string,
    evidenceList: ActionProposalSnapshot["sourceEvidence"]
  ): Promise<void> {
    const emailIds = [...new Set(evidenceList.map((evidence) => evidence.emailId))];
    const records = await this.store.findSourceEmails(userId, emailIds);
    const byId = new Map(records.map((record) => [record.id, record]));
    if (emailIds.some((emailId) => !byId.has(emailId))) throw actionContextNotFound();

    for (const evidence of evidenceList) {
      const source = byId.get(evidence.emailId);
      if (!source) throw actionContextNotFound();
      if (source.sourceRevision !== evidence.sourceRevision
        || source.threadId !== evidence.threadId
        || !`${source.subject}\n${source.bodyText}`.includes(evidence.quote)) {
        throw new ApiError(409, "ACTION_EVIDENCE_STALE", "The source evidence changed; refresh it before proposing this action");
      }
    }
  }

  private async transition(
    userId: string,
    untrustedProposalId: string,
    expectedPayloadHash: string,
    fromStatus: ActionProposal["status"],
    toStatus: ActionProposal["status"],
    actorType: "user" | "system",
    requestId: string | null,
    options: {
      executionMode?: "mock" | "provider";
      expectedExecutionKey?: string | null;
      expectedReconciliationClaimId?: string;
      setExecutionKey?: string;
      executionStartedAt?: Date | null;
      executionLeaseExpiresAt?: Date | null;
      incrementExecutionAttempts?: boolean;
      executionResultCode?: string | null;
    } = {}
  ): Promise<ActionProposal> {
    const proposalId = z.uuid().safeParse(untrustedProposalId);
    const hash = z.string().regex(/^[a-f0-9]{64}$/).safeParse(expectedPayloadHash);
    if (!proposalId.success || !hash.success) throw proposalNotFound();

    const current = await this.store.findById(userId, proposalId.data);
    if (!current) throw proposalNotFound();
    const currentProposal = toProposal(current, this.now());
    if (currentProposal.payloadHash !== hash.data) throw staleProposal();
    if (current.status === "expired") throw proposalExpired();

    const now = this.now();
    if ((current.status === "pending" || current.status === "approved")
      && current.expiresAt.getTime() <= now.getTime()) {
      await this.store.transitionProposal({
        userId,
        proposalId: proposalId.data,
        expectedPayloadHash: hash.data,
        fromStatus: current.status,
        toStatus: "expired",
        now,
        requireUnexpired: false,
        setDecidedAt: current.status === "pending",
        actorType: "system",
        requestId
      });
      throw proposalExpired();
    }

    if (current.status !== fromStatus) {
      if (current.status === toStatus) throw duplicateTransition();
      throw invalidTransition();
    }

    const updated = await this.store.transitionProposal({
      userId,
      proposalId: proposalId.data,
      expectedPayloadHash: hash.data,
      fromStatus,
      toStatus,
      now,
      requireUnexpired: fromStatus === "pending" || fromStatus === "approved",
      setDecidedAt: fromStatus === "pending",
      actorType,
      requestId,
      ...options
    });
    if (updated) return toProposal(updated, now);

    const afterRace = await this.store.findById(userId, proposalId.data);
    if (!afterRace) throw proposalNotFound();
    if (afterRace.payloadHash !== hash.data) throw staleProposal();
    if (afterRace.status === "expired") throw proposalExpired();
    if ((afterRace.status === "pending" || afterRace.status === "approved")
      && afterRace.expiresAt.getTime() <= this.now().getTime()) {
      await this.store.expireDue(userId, this.now(), requestId);
      throw proposalExpired();
    }
    if (afterRace.status === toStatus) throw duplicateTransition();
    throw invalidTransition();
  }

  private returnIdempotentOrConflict(
    record: ActionProposalRecord,
    userId: string,
    request: CreateActionProposalRequest
  ): ActionProposal {
    const proposal = toProposal(record, this.now());
    if (!matchesRequest(proposal.snapshot, userId, request)) {
      throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key belongs to a different action proposal");
    }
    return proposal;
  }
}

function toProposal(record: ActionProposalRecord, now: Date): ActionProposal {
  const parsedSnapshot = ActionProposalSnapshotSchema.safeParse(record.canonicalPayload);
  if (!parsedSnapshot.success) throw proposalIntegrityError();
  const snapshot = parsedSnapshot.data;
  if (record.userId !== snapshot.userId
    || record.agentRunId !== snapshot.agentRunId
    || record.idempotencyKey !== snapshot.idempotencyKey
    || record.actionType !== snapshot.actionType
    || record.createdAt.toISOString() !== snapshot.createdAt
    || record.expiresAt.toISOString() !== snapshot.expiresAt
    || record.payloadHash !== hashSnapshot(snapshot)) {
    throw proposalIntegrityError();
  }

  const status = (record.status === "pending" || record.status === "approved")
    && record.expiresAt.getTime() <= now.getTime()
    ? "expired"
    : record.status;
  const parsedProposal = ActionProposalSchema.safeParse({
    id: record.id,
    status,
    payloadHash: record.payloadHash,
    snapshot,
    execution: {
      attempts: record.executionAttempts,
      startedAt: record.executionStartedAt?.toISOString() ?? null,
      leaseExpiresAt: record.executionLeaseExpiresAt?.toISOString() ?? null,
      resultCode: record.executionResultCode
    }
  });
  if (!parsedProposal.success) throw proposalIntegrityError();
  return parsedProposal.data;
}

function matchesRequest(
  snapshot: ActionProposalSnapshot,
  userId: string,
  request: CreateActionProposalRequest
): boolean {
  return canonicalJson({
    userId: snapshot.userId,
    agentRunId: snapshot.agentRunId,
    idempotencyKey: snapshot.idempotencyKey,
    actionType: snapshot.actionType,
    payload: snapshot.payload,
    sourceEvidence: snapshot.sourceEvidence
  }) === canonicalJson({
    userId,
    agentRunId: request.agentRunId,
    idempotencyKey: request.idempotencyKey,
    actionType: request.actionType,
    payload: request.payload,
    sourceEvidence: request.sourceEvidence
  });
}

function riskForAction(actionType: CreateActionProposalRequest["actionType"]): "low" | "medium" | "high" {
  switch (actionType) {
    case "send_email": return "high";
    case "create_task": return "low";
    case "schedule_follow_up": return "medium";
    case "create_calendar_event": return "medium";
  }
}

function hashSnapshot(snapshot: ActionProposalSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

function createExecutionKey(proposalId: string, payloadHash: string): string {
  return createHash("sha256").update(`mailpilot-action-execution-v1:${proposalId}:${payloadHash}`).digest("hex");
}

function executionResultCode(outcome: "succeeded" | "failed" | "partial" | "uncertain" | "timeout"): string {
  switch (outcome) {
    case "succeeded": return "EXECUTION_SUCCEEDED";
    case "failed": return "EXECUTION_FAILED_CONFIRMED";
    case "partial": return "EXECUTION_PARTIAL_OUTCOME";
    case "uncertain": return "EXECUTION_OUTCOME_UNKNOWN";
    case "timeout": return "EXECUTION_TIMEOUT";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw proposalIntegrityError();
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  const entries = Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
  return `{${entries.join(",")}}`;
}

function invalidProposalRequest(): ApiError {
  return new ApiError(400, "INVALID_ACTION_PROPOSAL", "Action proposal is invalid");
}

function actionContextNotFound(): ApiError {
  return new ApiError(404, "ACTION_CONTEXT_NOT_FOUND", "Action context is unavailable");
}

function proposalIntegrityError(): ApiError {
  return new ApiError(500, "ACTION_PROPOSAL_INTEGRITY_ERROR", "Action proposal could not be verified");
}

function parseDecisionHash(untrustedBody: unknown): string {
  const parsed = ActionProposalDecisionRequestSchema.safeParse(untrustedBody);
  if (!parsed.success) throw new ApiError(400, "INVALID_ACTION_DECISION", "Action decision is invalid");
  return parsed.data.payloadHash;
}

function proposalNotFound(): ApiError {
  return new ApiError(404, "ACTION_PROPOSAL_NOT_FOUND", "Action proposal was not found");
}

function staleProposal(): ApiError {
  return new ApiError(409, "ACTION_PROPOSAL_STALE", "The proposal changed; review the current payload and request a new approval");
}

function proposalExpired(): ApiError {
  return new ApiError(410, "ACTION_PROPOSAL_EXPIRED", "The action proposal has expired");
}

function duplicateTransition(): ApiError {
  return new ApiError(409, "ACTION_PROPOSAL_ALREADY_DECIDED", "The action proposal has already left the pending state");
}

function invalidTransition(): ApiError {
  return new ApiError(409, "ACTION_PROPOSAL_INVALID_TRANSITION", "The action proposal cannot make that state transition");
}

function reconciliationRequired(): ApiError {
  return new ApiError(409, "ACTION_RECONCILIATION_REQUIRED", "Check the execution outcome before attempting another run");
}

function executionStillInProgress(): ApiError {
  return new ApiError(409, "ACTION_EXECUTION_IN_PROGRESS", "The action is still running; check its outcome again after it finishes");
}

function reconciliationInProgress(): ApiError {
  return new ApiError(409, "ACTION_RECONCILIATION_IN_PROGRESS", "Another outcome check is still in progress");
}
