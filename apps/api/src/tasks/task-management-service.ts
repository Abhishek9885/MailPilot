import {
  TaskListFilterSchema,
  TaskListResponseSchema,
  TaskReadResponseSchema,
  TaskUpdateRequestSchema,
} from "@mailpilot/shared";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { ApiError } from "../errors.js";

const TaskIdSchema = z.uuid();
type TaskListFilter = z.infer<typeof TaskListFilterSchema>;
type TaskUpdate = z.infer<typeof TaskUpdateRequestSchema>;
type TaskListResponse = z.infer<typeof TaskListResponseSchema>;
type TaskRecord = z.infer<typeof TaskReadResponseSchema>["task"];

const TASK_SELECT = {
  id: true,
  title: true,
  assignee: true,
  status: true,
  dueAt: true,
  dueTimezone: true,
  dueDateSource: true,
  confidence: true,
  sourceEmailId: true,
  sourceThreadId: true,
  sourceRevision: true,
  sourceEvidence: true,
  titleEditedAt: true,
  lastObservedAt: true,
  reviewedAt: true,
  completedAt: true,
  dismissedAt: true,
  supersededAt: true,
  createdAt: true,
  updatedAt: true,
  sourceEmail: {
    select: {
      id: true,
      providerThreadId: true,
      subject: true,
      senderName: true,
      senderEmailNormalized: true,
      receivedAt: true
    }
  }
} satisfies Prisma.TaskSelect;

type TaskRecordRow = Prisma.TaskGetPayload<{ select: typeof TASK_SELECT }>;

export interface TaskManagementStore {
  list(userId: string, filter: TaskListFilter): Promise<TaskListResponse>;
  update(userId: string, taskId: string, update: TaskUpdate): Promise<TaskRecord>;
}

export class TaskManagementService {
  public constructor(private readonly store: TaskManagementStore) {}

  public async list(userId: string, untrustedFilter: unknown): Promise<TaskListResponse> {
    const parsedFilter = TaskListFilterSchema.safeParse(untrustedFilter ?? "open");
    if (!parsedFilter.success) throw new ApiError(400, "INVALID_ARGUMENT", "Task filter is invalid");
    return TaskListResponseSchema.parse(await this.store.list(userId, parsedFilter.data));
  }

  public async update(
    userId: string,
    untrustedTaskId: string,
    untrustedUpdate: unknown
  ): Promise<TaskRecord> {
    const taskId = TaskIdSchema.safeParse(untrustedTaskId);
    if (!taskId.success) throw new ApiError(404, "TASK_NOT_FOUND", "Task was not found");
    const update = TaskUpdateRequestSchema.safeParse(untrustedUpdate);
    if (!update.success) throw new ApiError(400, "INVALID_ARGUMENT", "Task update is invalid");
    return TaskReadResponseSchema.shape.task.parse(
      await this.store.update(userId, taskId.data, update.data)
    );
  }
}

export class PrismaTaskManagementStore implements TaskManagementStore {
  public constructor(private readonly database: PrismaClient) {}

  public async list(userId: string, filter: TaskListFilter): Promise<TaskListResponse> {
    const where: Prisma.TaskWhereInput = filter === "open"
      ? { userId, status: { in: ["pending_review", "active"] } }
      : filter === "all"
        ? { userId }
        : { userId, status: filter };
    const tasks = await this.database.task.findMany({
      where,
      orderBy: [
        { dueAt: { sort: "asc", nulls: "last" } },
        { updatedAt: "desc" },
        { id: "asc" }
      ],
      take: 100,
      select: TASK_SELECT
    });
    return TaskListResponseSchema.parse({ tasks: tasks.map(toTaskRecord) });
  }

  public async update(userId: string, taskId: string, update: TaskUpdate): Promise<TaskRecord> {
    return this.database.$transaction(async (transaction) => {
      const current = await transaction.task.findFirst({
        where: { id: taskId, userId },
        select: { id: true, status: true, reviewedAt: true, updatedAt: true }
      });
      if (!current) throw new ApiError(404, "TASK_NOT_FOUND", "Task was not found");
      if (current.status !== "pending_review" && current.status !== "active") {
        throw new ApiError(409, "TASK_NOT_EDITABLE", "This task is no longer open for changes");
      }

      const now = new Date();
      const data: Prisma.TaskUpdateManyMutationInput = {};
      if (update.title !== undefined) {
        data.title = update.title;
        data.titleEditedAt = now;
      }
      if (update.dueDate !== undefined) {
        data.dueAt = update.dueDate === null
          ? null
          : new Date(`${update.dueDate}T00:00:00.000Z`);
        data.dueTimezone = null;
        data.dueDateSource = "user";
      }

      if (update.status === "completed") {
        data.status = "completed";
        data.completedAt = now;
        data.reviewedAt = current.reviewedAt ?? now;
      } else if (update.status === "dismissed") {
        data.status = "dismissed";
        data.dismissedAt = now;
        data.reviewedAt = current.reviewedAt ?? now;
      } else {
        data.status = "active";
        data.reviewedAt = current.reviewedAt ?? now;
      }

      const changed = await transaction.task.updateMany({
        where: {
          id: taskId,
          userId,
          status: { in: ["pending_review", "active"] },
          updatedAt: current.updatedAt
        },
        data
      });
      if (changed.count !== 1) {
        throw new ApiError(409, "TASK_NOT_EDITABLE", "This task is no longer open for changes");
      }

      const saved = await transaction.task.findFirst({
        where: { id: taskId, userId },
        select: TASK_SELECT
      });
      if (!saved) throw new ApiError(404, "TASK_NOT_FOUND", "Task was not found");
      return toTaskRecord(saved);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}

function toTaskRecord(row: TaskRecordRow): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    assignee: row.assignee,
    status: row.status,
    dueAt: row.dueAt?.toISOString() ?? null,
    dueTimezone: row.dueTimezone,
    dueDateSource: row.dueDateSource,
    confidence: row.confidence,
    sourceEmailId: row.sourceEmailId,
    sourceThreadId: row.sourceThreadId,
    sourceRevision: row.sourceRevision,
    sourceEvidence: row.sourceEvidence,
    sourceEmail: row.sourceEmail ? {
      id: row.sourceEmail.id,
      providerThreadId: row.sourceEmail.providerThreadId,
      subject: row.sourceEmail.subject,
      senderName: row.sourceEmail.senderName,
      senderEmail: row.sourceEmail.senderEmailNormalized,
      receivedAt: row.sourceEmail.receivedAt.toISOString()
    } : null,
    titleEditedAt: row.titleEditedAt?.toISOString() ?? null,
    lastObservedAt: row.lastObservedAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    supersededAt: row.supersededAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}
