import { createHash } from "node:crypto";
import type { EmailAnalysisServiceResponse } from "@mailpilot/shared";
import type { TaskDueDateSource } from "../generated/prisma/client.js";

export type ExtractedTask = EmailAnalysisServiceResponse["analysis"]["actionItems"][number];
export type ExtractedCommitment = EmailAnalysisServiceResponse["analysis"]["commitments"][number];

export interface TaskCandidateWrite {
  userId: string;
  sourceEmailId: string;
  sourceConnectionId: string;
  sourceThreadId: string;
  sourceRevision: number;
  sourceEvidence: string;
  deduplicationKey: string;
  title: string;
  assignee: ExtractedTask["owner"];
  dueAt: Date | null;
  dueTimezone: null;
  dueDateSource: TaskDueDateSource;
  confidence: null;
  lastObservedAt: Date;
}

export interface CommitmentCandidateWrite {
  userId: string;
  sourceEmailId: string;
  sourceConnectionId: string;
  sourceThreadId: string;
  sourceRevision: number;
  sourceEvidence: string;
  deduplicationKey: string;
  speaker: ExtractedCommitment["speaker"];
  statement: string;
  dueAt: Date | null;
  dueTimezone: null;
  confidence: null;
  lastObservedAt: Date;
}

export interface TaskCommitmentSyncPlan {
  userId: string;
  sourceEmailId: string;
  sourceConnectionId: string;
  sourceThreadId: string;
  sourceRevision: number;
  observedAt: Date;
  tasks: TaskCandidateWrite[];
  commitments: CommitmentCandidateWrite[];
}

function normalizeIdentityText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function hashIdentity(kind: string, actor: string, text: string): string {
  const canonicalText = normalizeIdentityText(text);
  return createHash("sha256").update(`${kind}\0${actor}\0${canonicalText}`).digest("hex");
}

function dateAtUtcMidnight(date: string | null): Date | null {
  return date === null ? null : new Date(`${date}T00:00:00.000Z`);
}

function uniqueByKey<T extends { deduplicationKey: string }>(candidates: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const candidate of candidates) {
    byKey.set(candidate.deduplicationKey, candidate);
  }
  return [...byKey.values()];
}

export function buildTaskCommitmentSyncPlan(
  result: EmailAnalysisServiceResponse,
  sourceConnectionId: string,
  sourceThreadId: string,
  observedAt = new Date()
): TaskCommitmentSyncPlan {
  if (!sourceConnectionId.trim() || !sourceThreadId.trim()) {
    throw new Error("Source connection and thread IDs are required for extracted records");
  }

  const tasks = result.analysis.actionItems.map((item): TaskCandidateWrite => ({
    userId: result.userId,
    sourceEmailId: result.emailId,
    sourceConnectionId,
    sourceThreadId,
    sourceRevision: result.sourceRevision,
    sourceEvidence: item.evidence,
    deduplicationKey: hashIdentity("task", item.owner, item.task),
    title: item.task,
    assignee: item.owner,
    dueAt: dateAtUtcMidnight(item.dueDate),
    dueTimezone: null,
    dueDateSource: item.dueDateBasis,
    confidence: null,
    lastObservedAt: observedAt
  }));

  const commitments = result.analysis.commitments.map((item): CommitmentCandidateWrite => ({
    userId: result.userId,
    sourceEmailId: result.emailId,
    sourceConnectionId,
    sourceThreadId,
    sourceRevision: result.sourceRevision,
    sourceEvidence: item.evidence,
    deduplicationKey: hashIdentity("commitment", item.speaker, item.commitment),
    speaker: item.speaker,
    statement: item.commitment,
    dueAt: dateAtUtcMidnight(item.dueDate),
    dueTimezone: null,
    confidence: null,
    lastObservedAt: observedAt
  }));

  return {
    userId: result.userId,
    sourceEmailId: result.emailId,
    sourceConnectionId,
    sourceThreadId,
    sourceRevision: result.sourceRevision,
    observedAt,
    tasks: uniqueByKey(tasks),
    commitments: uniqueByKey(commitments)
  };
}

export function taskStatusIsTerminal(status: string): boolean {
  return status === "completed" || status === "dismissed" || status === "superseded";
}

export function commitmentStatusIsTerminal(status: string): boolean {
  return status === "fulfilled"
    || status === "withdrawn"
    || status === "dismissed"
    || status === "superseded";
}
