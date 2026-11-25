import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import {
  commitmentStatusIsTerminal,
  taskStatusIsTerminal,
  type TaskCommitmentSyncPlan
} from "./task-commitment-service.js";

export class PrismaTaskCommitmentStore {
  public constructor(private readonly database: PrismaClient) {}

  public async syncAnalysis(
    transaction: Prisma.TransactionClient,
    plan: TaskCommitmentSyncPlan
  ): Promise<void> {
    const taskKeys = plan.tasks.map((candidate) => candidate.deduplicationKey);
    const commitmentKeys = plan.commitments.map((candidate) => candidate.deduplicationKey);

    for (const candidate of plan.tasks) {
      const where = {
        userId_sourceConnectionId_sourceThreadId_deduplicationKey: {
          userId: candidate.userId,
          sourceConnectionId: candidate.sourceConnectionId,
          sourceThreadId: candidate.sourceThreadId,
          deduplicationKey: candidate.deduplicationKey
        }
      };
      const current = await transaction.task.findUnique({
        where,
        select: { id: true, status: true, titleEditedAt: true, dueDateSource: true }
      });
      if (!current) {
        await transaction.task.create({ data: candidate });
      } else if (!taskStatusIsTerminal(current.status)) {
        const {
          title,
          dueAt,
          dueTimezone,
          dueDateSource,
          ...sourceRefresh
        } = candidate;
        await transaction.task.update({
          where: { id: current.id, userId: candidate.userId },
          data: {
            ...sourceRefresh,
            ...(current.titleEditedAt === null ? { title } : {}),
            ...(current.dueDateSource === "user"
              ? {}
              : { dueAt, dueTimezone, dueDateSource })
          }
        });
      }
    }

    for (const candidate of plan.commitments) {
      const where = {
        userId_sourceConnectionId_sourceThreadId_deduplicationKey: {
          userId: candidate.userId,
          sourceConnectionId: candidate.sourceConnectionId,
          sourceThreadId: candidate.sourceThreadId,
          deduplicationKey: candidate.deduplicationKey
        }
      };
      const current = await transaction.commitment.findUnique({
        where,
        select: { id: true, status: true }
      });
      if (!current) {
        await transaction.commitment.create({ data: candidate });
      } else if (!commitmentStatusIsTerminal(current.status)) {
        await transaction.commitment.update({
          where: { id: current.id, userId: candidate.userId },
          data: candidate
        });
      }
    }

    await transaction.task.updateMany({
      where: {
        userId: plan.userId,
        sourceEmailId: plan.sourceEmailId,
        sourceRevision: { lte: plan.sourceRevision },
        status: { in: ["pending_review", "active"] },
        ...(taskKeys.length > 0 ? { deduplicationKey: { notIn: taskKeys } } : {})
      },
      data: {
        status: "superseded",
        supersededAt: plan.observedAt,
        updatedAt: plan.observedAt
      }
    });

    await transaction.commitment.updateMany({
      where: {
        userId: plan.userId,
        sourceEmailId: plan.sourceEmailId,
        sourceRevision: { lte: plan.sourceRevision },
        status: { in: ["pending_review", "active"] },
        ...(commitmentKeys.length > 0 ? { deduplicationKey: { notIn: commitmentKeys } } : {})
      },
      data: {
        status: "superseded",
        supersededAt: plan.observedAt,
        updatedAt: plan.observedAt
      }
    });
  }

  public async syncFromAnalysis(plan: TaskCommitmentSyncPlan): Promise<void> {
    await this.database.$transaction(
      async (transaction) => this.syncAnalysis(transaction, plan),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }
}
