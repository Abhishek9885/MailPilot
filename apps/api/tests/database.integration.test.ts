import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EmailAnalysisSchemaVersion, type EmailAnalysisServiceResponse } from "@mailpilot/shared";
import { PrismaEmailAnalysisStore } from "../src/analysis/email-analysis-store.js";
import { createDatabaseClient } from "../src/database.js";
import { assertSafeIntegrationTestTarget } from "../src/database-safety.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";

const configuredTestUrl = process.env.DATABASE_TEST_URL;
const testDatabaseUrl = configuredTestUrl ? validateTestUrl(configuredTestUrl) : null;
let database: PrismaClient | undefined;

function validateTestUrl(value: string): string {
  assertSafeIntegrationTestTarget(value);
  return value;
}

function findRepositoryRoot(startDirectory: string): string {
  let currentDirectory = resolve(startDirectory);

  while (true) {
    if (existsSync(join(currentDirectory, "prisma7.config.ts"))) return currentDirectory;
    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) throw new Error("Could not locate the MailPilot repository root.");
    currentDirectory = parentDirectory;
  }
}

function runPrismaCommand(repositoryRoot: string, databaseUrl: string, command: string[]): void {
  const prismaCli = join(repositoryRoot, "node_modules", "prisma", "build", "index.js");
  try {
    execFileSync(process.execPath, [prismaCli, ...command], {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: "test" },
      encoding: "utf8",
      stdio: "pipe"
    });
  } catch {
    throw new Error(`Prisma ${command.join(" ")} failed against the isolated local integration database.`);
  }
}

describe.skipIf(testDatabaseUrl === null)("PostgreSQL integration", () => {
  beforeAll(async () => {
    if (!testDatabaseUrl) throw new Error("DATABASE_TEST_URL is required for database integration tests.");
    const repositoryRoot = findRepositoryRoot(process.cwd());
    // Apply missing migrations without dropping the isolated test database.
    runPrismaCommand(repositoryRoot, testDatabaseUrl, ["migrate", "deploy"]);
    database = createDatabaseClient(testDatabaseUrl);
    await database.$connect();
  }, 60_000);

  afterAll(async () => {
    await database?.$disconnect();
  });

  it("connects through the API PostgreSQL adapter", async () => {
    if (!database) throw new Error("Integration database was not initialized.");
    const rows = await database.$queryRaw<Array<{ result: number }>>`SELECT 1::int AS result`;

    expect(rows).toEqual([{ result: 1 }]);
  });

  it("applies migrations and supports a scoped user record round trip", async () => {
    if (!database) throw new Error("Integration database was not initialized.");
    const relations = await database.$queryRaw<Array<{ tableName: string | null }>>`
      SELECT to_regclass('app.users')::text AS "tableName"
    `;
    expect(relations[0]?.tableName).toBe("app.users");

    const emailNormalized = `integration-${randomUUID()}@mailpilot.invalid`;
    try {
      const created = await database.user.create({ data: { emailNormalized } });
      const loaded = await database.user.findUnique({ where: { id: created.id } });
      expect(loaded).toMatchObject({ emailNormalized, status: "active" });
    } finally {
      await database.user.deleteMany({ where: { emailNormalized } });
    }
  });

  it("enforces identity uniqueness, tenant ownership, data checks, and deletion behavior", async () => {
    if (!database) throw new Error("Integration database was not initialized.");

    const uniquePart = randomUUID().replaceAll("-", "");
    const primaryEmail = `primary-${uniquePart}@mailpilot.invalid`;
    const secondaryEmail = `secondary-${uniquePart}@mailpilot.invalid`;
    const tokenHash = uniquePart.repeat(2);
    let primaryUserId: string | undefined;
    let secondaryUserId: string | undefined;
    let auditLogId: string | undefined;

    try {
      const primaryUser = await database.user.create({ data: { emailNormalized: primaryEmail } });
      primaryUserId = primaryUser.id;
      const secondaryUser = await database.user.create({ data: { emailNormalized: secondaryEmail } });
      secondaryUserId = secondaryUser.id;

      await database.authenticationIdentity.create({
        data: { userId: primaryUser.id, provider: "google", providerSubject: `identity-${uniquePart}` }
      });
      await expect(database.authenticationIdentity.create({
        data: { userId: secondaryUser.id, provider: "google", providerSubject: `identity-${uniquePart}` }
      })).rejects.toMatchObject({ code: "P2002" });

      const expiresAt = new Date(Date.now() + 60_000);
      await database.session.create({ data: { userId: primaryUser.id, tokenHash, expiresAt } });
      await expect(database.session.create({
        data: { userId: secondaryUser.id, tokenHash, expiresAt }
      })).rejects.toMatchObject({ code: "P2002" });

      const primaryConnection = await database.googleConnection.create({
        data: {
          userId: primaryUser.id,
          providerSubject: `google-${uniquePart}`,
          providerEmailNormalized: `google-${uniquePart}@mailpilot.invalid`
        }
      });
      const secondaryConnection = await database.googleConnection.create({
        data: {
          userId: secondaryUser.id,
          providerSubject: `google-other-${uniquePart}`,
          providerEmailNormalized: `google-other-${uniquePart}@mailpilot.invalid`
        }
      });

      const emailData = {
        userId: primaryUser.id,
        googleConnectionId: primaryConnection.id,
        providerMessageId: `message-${uniquePart}`,
        providerThreadId: `thread-${uniquePart}`,
        senderEmailNormalized: `sender-${uniquePart}@mailpilot.invalid`,
        subject: "Integration fixture",
        bodyText: "Integration fixture content",
        bodyHash: "a".repeat(64),
        receivedAt: new Date()
      };
      await expect(database.email.create({
        data: { ...emailData, userId: primaryUser.id, googleConnectionId: secondaryConnection.id }
      })).rejects.toMatchObject({ code: "P2003" });

      const email = await database.email.create({ data: emailData });
      await expect(database.email.create({ data: emailData })).rejects.toMatchObject({ code: "P2002" });

      const analysisData = {
        userId: primaryUser.id,
        emailId: email.id,
        sourceRevision: 1,
        schemaVersion: "analysis-v1",
        modelVersion: "test-model-v1"
      };
      await database.analysis.create({ data: analysisData });
      await expect(database.analysis.create({ data: analysisData })).rejects.toMatchObject({ code: "P2002" });
      await expect(database.analysis.create({
        data: {
          ...analysisData,
          userId: secondaryUser.id,
          schemaVersion: "analysis-v1-cross-user"
        }
      })).rejects.toMatchObject({ code: "P2003" });

      await database.emailChunk.create({
        data: {
          userId: primaryUser.id,
          emailId: email.id,
          sourceRevision: 1,
          chunkerVersion: "chunker-v1",
          ordinal: 0,
          startChar: 0,
          endChar: 5,
          content: "hello",
          contentHash: "b".repeat(64)
        }
      });
      await expect(database.emailChunk.create({
        data: {
          userId: secondaryUser.id,
          emailId: email.id,
          sourceRevision: 1,
          chunkerVersion: "chunker-v1",
          ordinal: 1,
          startChar: 5,
          endChar: 10,
          content: "world",
          contentHash: "c".repeat(64)
        }
      })).rejects.toMatchObject({ code: "P2003" });
      await expect(database.emailChunk.create({
        data: {
          userId: primaryUser.id,
          emailId: email.id,
          sourceRevision: 1,
          chunkerVersion: "chunker-v1",
          ordinal: 1,
          startChar: 5,
          endChar: 4,
          content: "invalid",
          contentHash: "c".repeat(64)
        }
      })).rejects.toMatchObject({ code: "P2039" });

      const agentRun = await database.agentRun.create({
        data: {
          userId: primaryUser.id,
          requestReference: `request-${uniquePart}`,
          intent: "analyze_email",
          graphVersion: "workflow-v1"
        }
      });
      await expect(database.agentRun.create({
        data: {
          userId: primaryUser.id,
          requestReference: `request-${uniquePart}`,
          intent: "analyze_email",
          graphVersion: "workflow-v1"
        }
      })).rejects.toMatchObject({ code: "P2002" });
      await expect(database.agentRun.create({
        data: {
          userId: primaryUser.id,
          googleConnectionId: secondaryConnection.id,
          requestReference: `cross-connection-${uniquePart}`,
          intent: "analyze_email",
          graphVersion: "workflow-v1"
        }
      })).rejects.toMatchObject({ code: "P2003" });

      const pendingAction = await database.pendingAction.create({
        data: {
          userId: primaryUser.id,
          agentRunId: agentRun.id,
          idempotencyKey: `action-${uniquePart}`,
          actionType: "send_email",
          canonicalPayload: { to: [`recipient-${uniquePart}@mailpilot.invalid`], subject: "Fixture", body: "Fixture" },
          payloadHash: "d".repeat(64),
          expiresAt
        }
      });
      await expect(database.pendingAction.update({
        where: { id: pendingAction.id },
        data: {
          canonicalPayload: { to: ["changed@example.invalid"], subject: "Changed", body: "Changed" }
        }
      })).rejects.toMatchObject({ code: "P2039" });

      const decidedAt = new Date();
      await database.pendingAction.update({
        where: { id: pendingAction.id },
        data: { status: "approved", decidedAt }
      });
      await database.pendingAction.update({
        where: { id: pendingAction.id },
        data: {
          status: "executing",
          executionKey: "f".repeat(64),
          executionStartedAt: new Date(),
          executionLeaseExpiresAt: new Date(Date.now() + 30_000),
          executionAttempts: 1
        }
      });
      await expect(database.pendingAction.update({
        where: { id: pendingAction.id },
        data: { executionKey: "a".repeat(64) }
      })).rejects.toMatchObject({ code: "P2039" });
      await database.pendingAction.update({
        where: { id: pendingAction.id },
        data: {
          status: "reconciliation_required",
          executionLeaseExpiresAt: null,
          executionResultCode: "EXECUTION_OUTCOME_UNKNOWN"
        }
      });
      const reconciliationClaimId = randomUUID();
      await database.pendingAction.update({
        where: { id: pendingAction.id },
        data: {
          reconciliationClaimId,
          reconciliationLeaseExpiresAt: new Date(Date.now() + 30_000),
          reconciliationAttempts: 1
        }
      });
      await expect(database.pendingAction.update({
        where: { id: pendingAction.id },
        data: { status: "approved", executionResultCode: "EXECUTION_OUTCOME_UNKNOWN" }
      })).rejects.toMatchObject({ code: "P2039" });
      await database.pendingAction.update({
        where: { id: pendingAction.id },
        data: {
          status: "approved",
          executionResultCode: "EXECUTION_NOT_PERFORMED_CONFIRMED",
          reconciliationClaimId: null,
          reconciliationLeaseExpiresAt: null
        }
      });
      await database.pendingAction.update({
        where: { id: pendingAction.id },
        data: {
          status: "executing",
          executionStartedAt: new Date(),
          executionLeaseExpiresAt: new Date(Date.now() + 30_000),
          executionAttempts: 2,
          executionResultCode: null
        }
      });
      await database.pendingAction.update({
        where: { id: pendingAction.id },
        data: { status: "succeeded", executionLeaseExpiresAt: null, executionResultCode: "EXECUTION_SUCCEEDED" }
      });
      await expect(database.pendingAction.update({
        where: { id: pendingAction.id },
        data: { status: "failed" }
      })).rejects.toMatchObject({ code: "P2039" });
      await expect(database.pendingAction.create({
        data: {
          userId: secondaryUser.id,
          agentRunId: agentRun.id,
          idempotencyKey: `cross-run-${uniquePart}`,
          actionType: "draft_email",
          canonicalPayload: { subject: "Fixture" },
          payloadHash: "e".repeat(64),
          expiresAt
        }
      })).rejects.toMatchObject({ code: "P2003" });

      const task = await database.task.create({
        data: {
          userId: primaryUser.id,
          agentRunId: agentRun.id,
          sourceEmailId: email.id,
          sourceConnectionId: primaryConnection.id,
          sourceThreadId: email.providerThreadId,
          sourceRevision: email.sourceRevision,
          sourceEvidence: "Please send the report by Monday.",
          deduplicationKey: "1".repeat(64),
          assignee: "user",
          dueAt: new Date("2026-11-02T00:00:00.000Z"),
          dueTimezone: "America/Los_Angeles",
          title: "Integration task",
          confidence: 0.5
        }
      });
      await expect(database.task.create({
        data: {
          userId: primaryUser.id,
          sourceEmailId: email.id,
          sourceConnectionId: primaryConnection.id,
          sourceThreadId: email.providerThreadId,
          deduplicationKey: "1".repeat(64),
          title: "Duplicate integration task"
        }
      })).rejects.toMatchObject({ code: "P2002" });
      await expect(database.task.create({
        data: { userId: primaryUser.id, title: "Invalid confidence", confidence: 1.5 }
      })).rejects.toMatchObject({ code: "P2039" });
      await expect(database.task.create({
        data: {
          userId: secondaryUser.id,
          sourceEmailId: email.id,
          sourceConnectionId: primaryConnection.id,
          sourceThreadId: email.providerThreadId,
          title: "Cross-owner task"
        }
      })).rejects.toMatchObject({ code: "P2003" });
      await expect(database.task.create({
        data: {
          userId: primaryUser.id,
          sourceEmailId: email.id,
          sourceConnectionId: primaryConnection.id,
          sourceThreadId: "different-thread",
          title: "Mismatched source thread"
        }
      })).rejects.toMatchObject({ code: "P2039" });

      const commitment = await database.commitment.create({
        data: {
          userId: primaryUser.id,
          sourceEmailId: email.id,
          sourceConnectionId: primaryConnection.id,
          sourceThreadId: email.providerThreadId,
          sourceRevision: email.sourceRevision,
          sourceEvidence: "I will send the report by Monday.",
          deduplicationKey: "2".repeat(64),
          speaker: "sender",
          statement: "The sender will send the report.",
          dueAt: new Date("2026-11-02T00:00:00.000Z"),
          dueTimezone: "America/Los_Angeles",
          confidence: 0.8
        }
      });
      expect(commitment.status).toBe("pending_review");
      await expect(database.commitment.create({
        data: {
          userId: primaryUser.id,
          sourceEmailId: email.id,
          sourceConnectionId: primaryConnection.id,
          sourceThreadId: email.providerThreadId,
          sourceEvidence: "Repeated promise",
          deduplicationKey: "2".repeat(64),
          speaker: "sender",
          statement: "The sender will send the report."
        }
      })).rejects.toMatchObject({ code: "P2002" });
      await expect(database.commitment.create({
        data: {
          userId: secondaryUser.id,
          sourceEmailId: email.id,
          sourceConnectionId: primaryConnection.id,
          sourceThreadId: email.providerThreadId,
          sourceEvidence: "Cross-owner promise",
          deduplicationKey: "3".repeat(64),
          speaker: "sender",
          statement: "Cross-owner promise"
        }
      })).rejects.toMatchObject({ code: "P2003" });
      await expect(database.commitment.create({
        data: {
          userId: primaryUser.id,
          sourceEmailId: email.id,
          sourceConnectionId: primaryConnection.id,
          sourceThreadId: "different-thread",
          sourceEvidence: "Mismatched source",
          deduplicationKey: "4".repeat(64),
          speaker: "sender",
          statement: "Mismatched source"
        }
      })).rejects.toMatchObject({ code: "P2039" });
      await expect(database.commitment.create({
        data: {
          userId: primaryUser.id,
          sourceEmailId: email.id,
          sourceConnectionId: primaryConnection.id,
          sourceThreadId: email.providerThreadId,
          sourceEvidence: "Invalid confidence",
          deduplicationKey: "5".repeat(64),
          speaker: "sender",
          statement: "Invalid confidence",
          confidence: 1.1
        }
      })).rejects.toMatchObject({ code: "P2039" });

      await database.followUp.create({
        data: {
          userId: primaryUser.id, emailId: email.id, taskId: task.id, scheduledAt: expiresAt,
          sourceThreadId: email.providerThreadId, kind: "stale_thread", deduplicationKey: "test-followup-1",
          title: "Follow up", reason: "No newer message in this conversation."
        }
      });
      await expect(database.followUp.create({
        data: {
          userId: primaryUser.id, emailId: email.id, scheduledAt: expiresAt,
          sourceThreadId: email.providerThreadId, kind: "stale_thread", deduplicationKey: "test-followup-1",
          title: "Follow up", reason: "No newer message in this conversation."
        }
      })).rejects.toMatchObject({ code: "P2002" });
      await expect(database.followUp.create({
        data: {
          userId: secondaryUser.id,
          emailId: email.id,
          taskId: task.id,
          scheduledAt: new Date(expiresAt.getTime() + 1_000),
          sourceThreadId: email.providerThreadId,
          kind: "stale_thread",
          deduplicationKey: "test-followup-2",
          title: "Follow up",
          reason: "No newer message in this conversation."
        }
      })).rejects.toMatchObject({ code: "P2003" });

      const auditLog = await database.auditLog.create({
        data: {
          userId: primaryUser.id,
          actorType: "user",
          eventType: "integration.constraint_test"
        }
      });
      auditLogId = auditLog.id;

      await database.user.delete({ where: { id: primaryUser.id } });
      primaryUserId = undefined;

      expect(await database.email.findUnique({ where: { id: email.id } })).toBeNull();
      expect(await database.auditLog.findUnique({ where: { id: auditLog.id } })).toMatchObject({ userId: null });
    } finally {
      if (primaryUserId) await database.user.deleteMany({ where: { id: primaryUserId } });
      if (secondaryUserId) await database.user.deleteMany({ where: { id: secondaryUserId } });
      if (auditLogId) await database.auditLog.deleteMany({ where: { id: auditLogId } });
    }
  });

  it("deduplicates extracted records, refreshes new-message evidence, and supersedes removed items", async () => {
    if (!database) throw new Error("Integration database was not initialized.");

    const uniquePart = randomUUID().replaceAll("-", "");
    let userId: string | undefined;
    let otherUserId: string | undefined;
    try {
      const user = await database.user.create({
        data: { emailNormalized: `tasks-${uniquePart}@mailpilot.invalid` }
      });
      userId = user.id;
      const otherUser = await database.user.create({
        data: { emailNormalized: `tasks-other-${uniquePart}@mailpilot.invalid` }
      });
      otherUserId = otherUser.id;
      const connection = await database.googleConnection.create({
        data: {
          userId,
          providerSubject: `tasks-google-${uniquePart}`,
          providerEmailNormalized: `tasks-${uniquePart}@mailpilot.invalid`
        }
      });
      const threadId = `tasks-thread-${uniquePart}`;
      const firstEmail = await database.email.create({
        data: {
          userId,
          googleConnectionId: connection.id,
          providerMessageId: `tasks-message-1-${uniquePart}`,
          providerThreadId: threadId,
          subject: "Project brief",
          bodyText: "I will send and review the project brief.",
          bodyHash: "a".repeat(64),
          receivedAt: new Date("2026-11-19T12:00:00.000Z")
        }
      });
      const secondEmail = await database.email.create({
        data: {
          userId,
          googleConnectionId: connection.id,
          providerMessageId: `tasks-message-2-${uniquePart}`,
          providerThreadId: threadId,
          subject: "Updated project brief timing",
          bodyText: "I will send and review the project brief next week.",
          bodyHash: "b".repeat(64),
          receivedAt: new Date("2026-11-20T12:00:00.000Z")
        }
      });
      const store = new PrismaEmailAnalysisStore(database);
      const makeResult = (
        emailId: string,
        sourceRevision: number,
        dueDate: string,
        evidence: string,
        includeCandidates = true,
        sourceUserId = user.id
      ): EmailAnalysisServiceResponse => ({
        userId: sourceUserId,
        emailId,
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
          summary: "Project brief follow-through.",
          actionItems: includeCandidates ? [{
            task: "Send the project brief",
            owner: "user",
            dueDate,
            dueDateBasis: "explicit",
            evidence
          }] : [],
          deadlines: [],
          commitments: includeCandidates ? [{
            speaker: "sender",
            commitment: "The sender will review the project brief.",
            dueDate,
            evidence
          }] : [],
          eventCandidates: []
        }
      });

      await store.saveAnalysis(makeResult(
        firstEmail.id,
        firstEmail.sourceRevision,
        "2026-11-23",
        "I will send the project brief by Monday."
      ));
      const task = await database.task.findFirstOrThrow({
        where: { userId, sourceEmailId: firstEmail.id, title: "Send the project brief" }
      });
      const commitment = await database.commitment.findFirstOrThrow({
        where: { userId, sourceEmailId: firstEmail.id }
      });
      await database.task.update({
        where: { id: task.id },
        data: {
          status: "active",
          reviewedAt: new Date("2026-11-19T13:00:00.000Z"),
          title: "User-corrected task title",
          titleEditedAt: new Date("2026-11-19T13:10:00.000Z"),
          dueAt: new Date("2026-11-29T00:00:00.000Z"),
          dueDateSource: "user"
        }
      });
      await database.commitment.update({
        where: { id: commitment.id },
        data: { status: "active", reviewedAt: new Date("2026-11-19T13:00:00.000Z") }
      });

      await store.saveAnalysis(makeResult(
        secondEmail.id,
        secondEmail.sourceRevision,
        "2026-11-30",
        "I can send and review the project brief by Monday next week."
      ));
      const refreshedTask = await database.task.findUniqueOrThrow({ where: { id: task.id } });
      const refreshedCommitment = await database.commitment.findUniqueOrThrow({
        where: { id: commitment.id }
      });
      expect(refreshedTask).toMatchObject({
        status: "active",
        title: "User-corrected task title",
        sourceEmailId: secondEmail.id,
        sourceThreadId: threadId,
        dueAt: new Date("2026-11-29T00:00:00.000Z"),
        dueDateSource: "user",
        dueTimezone: null,
        confidence: null,
        sourceRevision: secondEmail.sourceRevision,
        sourceEvidence: "I can send and review the project brief by Monday next week."
      });
      expect(refreshedCommitment).toMatchObject({
        status: "active",
        sourceEmailId: secondEmail.id,
        sourceThreadId: threadId,
        dueAt: new Date("2026-11-30T00:00:00.000Z"),
        sourceEvidence: "I can send and review the project brief by Monday next week."
      });
      expect(await database.task.count({ where: { userId, sourceThreadId: threadId } })).toBe(1);
      expect(await database.commitment.count({ where: { userId, sourceThreadId: threadId } })).toBe(1);

      const otherConnection = await database.googleConnection.create({
        data: {
          userId: otherUser.id,
          providerSubject: `tasks-other-google-${uniquePart}`,
          providerEmailNormalized: `tasks-other-${uniquePart}@mailpilot.invalid`
        }
      });
      const sameProviderThreadIdEmail = await database.email.create({
        data: {
          userId: otherUser.id,
          googleConnectionId: otherConnection.id,
          providerMessageId: `tasks-other-message-${uniquePart}`,
          providerThreadId: threadId,
          subject: "Separate account thread",
          bodyText: "I will send the project brief by Monday.",
          bodyHash: "c".repeat(64),
          receivedAt: new Date("2026-11-20T13:00:00.000Z")
        }
      });
      await store.saveAnalysis(makeResult(
        sameProviderThreadIdEmail.id,
        sameProviderThreadIdEmail.sourceRevision,
        "2026-12-01",
        "I will send and review the project brief by Tuesday.",
        true,
        otherUser.id
      ));
      expect(await database.task.count({ where: { userId, sourceThreadId: threadId } })).toBe(1);
      expect(await database.commitment.count({ where: { userId, sourceThreadId: threadId } })).toBe(1);
      expect(await database.task.count({ where: { userId: otherUser.id, sourceThreadId: threadId } })).toBe(1);
      expect(await database.commitment.count({ where: { userId: otherUser.id, sourceThreadId: threadId } })).toBe(1);

      const revisedEmail = await database.email.update({
        where: { id: secondEmail.id },
        data: { sourceRevision: secondEmail.sourceRevision + 1 }
      });
      await store.saveAnalysis(makeResult(
        revisedEmail.id,
        revisedEmail.sourceRevision,
        "2026-11-30",
        "",
        false
      ));
      const supersededTask = await database.task.findUniqueOrThrow({ where: { id: task.id } });
      const supersededCommitment = await database.commitment.findUniqueOrThrow({
        where: { id: commitment.id }
      });
      expect(supersededTask.status).toBe("superseded");
      expect(supersededTask.supersededAt).toBeInstanceOf(Date);
      expect(supersededCommitment.status).toBe("superseded");
      expect(supersededCommitment.supersededAt).toBeInstanceOf(Date);
      expect(await database.task.count({
        where: { userId: otherUser.id, sourceConnectionId: otherConnection.id, status: "pending_review" }
      })).toBe(1);
      expect(await database.commitment.count({
        where: { userId: otherUser.id, sourceConnectionId: otherConnection.id, status: "pending_review" }
      })).toBe(1);
    } finally {
      if (otherUserId) await database.user.deleteMany({ where: { id: otherUserId } });
      if (userId) await database.user.deleteMany({ where: { id: userId } });
    }
  });
});
