import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    runPrismaCommand(repositoryRoot, testDatabaseUrl, ["migrate", "reset", "--force"]);
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
        data: { ...analysisData, userId: secondaryUser.id }
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
      })).rejects.toMatchObject({ code: "P2004" });

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

      await database.pendingAction.create({
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
          title: "Integration task",
          confidence: 0.5
        }
      });
      await expect(database.task.create({
        data: { userId: primaryUser.id, title: "Invalid confidence", confidence: 1.5 }
      })).rejects.toMatchObject({ code: "P2004" });
      await expect(database.task.create({
        data: { userId: secondaryUser.id, sourceEmailId: email.id, title: "Cross-owner task" }
      })).rejects.toMatchObject({ code: "P2003" });

      await database.followUp.create({
        data: { userId: primaryUser.id, emailId: email.id, taskId: task.id, scheduledAt: expiresAt }
      });
      await expect(database.followUp.create({
        data: { userId: primaryUser.id, emailId: email.id, scheduledAt: expiresAt }
      })).rejects.toMatchObject({ code: "P2002" });
      await expect(database.followUp.create({
        data: {
          userId: secondaryUser.id,
          emailId: email.id,
          taskId: task.id,
          scheduledAt: new Date(expiresAt.getTime() + 1_000)
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
});
