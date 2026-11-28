import { randomUUID } from "node:crypto";
import {
  EmailAnalysisSchemaVersion,
  type EmailAnalysisServiceResponse,
  type StoredEmailAnalysis
} from "@mailpilot/shared";
import { describe, expect, it } from "vitest";
import pino from "pino";
import request from "supertest";
import { createApp } from "../src/app.js";
import { hashSecret } from "../src/auth/cookies.js";
import type {
  AuthStore,
  CreateSessionInput,
  GoogleIdentity,
  SessionRecord
} from "../src/auth/types.js";
import type { EmailAnalysisClient } from "../src/analysis/email-analysis-client.js";
import { EmailAnalysisService } from "../src/analysis/email-analysis-service.js";
import type {
  AnalyzableEmail,
  EmailAnalysisStore
} from "../src/analysis/email-analysis-store.js";

const WEB_ORIGIN = "http://localhost:3000";
const SESSION_TOKEN = "s".repeat(43);
const CSRF_TOKEN = "csrf-token-for-analysis-test";

class MemoryAuthStore implements AuthStore {
  public readonly userId = randomUUID();
  private readonly sessions = new Map<string, SessionRecord>();

  public async authenticateGoogleIdentity(
    identity: GoogleIdentity,
    authenticatedAt: Date
  ): Promise<{ id: string; emailNormalized: string; status: "active" }> {
    void identity;
    void authenticatedAt;
    return { id: this.userId, emailNormalized: "owner@example.test", status: "active" };
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

  public seedSession(): void {
    this.sessions.set(hashSecret(SESSION_TOKEN), {
      id: randomUUID(),
      userId: this.userId,
      csrfTokenHash: hashSecret(CSRF_TOKEN),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      user: { emailNormalized: "owner@example.test", status: "active" }
    });
  }
}

class MemoryEmailAnalysisStore implements EmailAnalysisStore {
  public email: AnalyzableEmail | null = null;
  public stored: StoredEmailAnalysis | null = null;

  public async findEmailRevision(
    userId: string,
    emailId: string
  ): Promise<{ id: string; sourceRevision: number } | null> {
    return this.email?.userId === userId && this.email.id === emailId
      ? { id: this.email.id, sourceRevision: this.email.sourceRevision }
      : null;
  }

  public async findEmailForAnalysis(userId: string, emailId: string): Promise<AnalyzableEmail | null> {
    return this.email?.userId === userId && this.email.id === emailId ? this.email : null;
  }

  public async findCompletedAnalysis(
    userId: string,
    emailId: string,
    sourceRevision: number
  ): Promise<StoredEmailAnalysis | null> {
    return this.stored?.emailId === emailId
      && this.stored.sourceRevision === sourceRevision
      && this.email?.userId === userId
      ? this.stored
      : null;
  }

  public async saveAnalysis(result: EmailAnalysisServiceResponse): Promise<StoredEmailAnalysis> {
    this.stored = {
      id: randomUUID(),
      emailId: result.emailId,
      sourceRevision: result.sourceRevision,
      schemaVersion: result.schemaVersion,
      modelVersion: result.modelVersion,
      provider: result.provider,
      responseId: result.responseId,
      providerRequestId: result.providerRequestId,
      usage: result.usage,
      analysis: result.analysis,
      createdAt: new Date().toISOString()
    };
    return this.stored;
  }
}

class FakeEmailAnalysisClient implements EmailAnalysisClient {
  public calls = 0;
  public lastInput: Parameters<EmailAnalysisClient["analyze"]>[0] | undefined;

  public async analyze(
    input: Parameters<EmailAnalysisClient["analyze"]>[0]
  ): Promise<EmailAnalysisServiceResponse> {
    this.calls += 1;
    this.lastInput = input;
    return {
      userId: input.userId,
      emailId: input.emailId,
      sourceRevision: input.sourceRevision,
      schemaVersion: EmailAnalysisSchemaVersion,
      provider: "openai",
      modelVersion: "gpt-6.1-sol-test-snapshot",
      responseId: "resp_test_1",
      providerRequestId: "req_test_1",
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
        cachedInputTokens: null,
        reasoningOutputTokens: 5,
        cost: {
          estimatedCostUsd: "0.0002250000",
          pricingVersion: "test-rate-card",
          basis: "configured_token_rates"
        }
      },
      analysis: {
        categories: ["work"],
        priority: "high",
        summary: "Prepare and send the requested report.",
        actionItems: [{
          task: "Send the report",
          owner: "user",
          dueDate: "2026-11-02",
          dueDateBasis: "explicit",
          evidence: "Please send the report by Monday."
        }],
        deadlines: [],
        commitments: [],
        eventCandidates: []
      }
    };
  }
}

function createTestApp() {
  const authStore = new MemoryAuthStore();
  const emailStore = new MemoryEmailAnalysisStore();
  const analyzer = new FakeEmailAnalysisClient();
  const emailId = randomUUID();
  emailStore.email = {
    id: emailId,
    userId: authStore.userId,
    sourceRevision: 3,
    subject: "Quarterly report",
    senderName: "Manager",
    senderEmailNormalized: "manager@example.test",
    receivedAt: new Date("2026-10-28T12:00:00.000Z"),
    bodyText: "Please send the report by Monday."
  };
  authStore.seedSession();

  const app = createApp({
    checkDatabase: async () => undefined,
    authStore,
    emailAnalysisService: new EmailAnalysisService(emailStore, analyzer),
    logger: pino({ level: "silent" })
  });
  return { app, authStore, emailStore, analyzer, emailId };
}

function authenticatedPost(app: ReturnType<typeof createApp>, emailId: string) {
  return request(app)
    .post(`/v1/emails/${emailId}/analysis`)
    .set("Origin", WEB_ORIGIN)
    .set("Cookie", `mailpilot_session=${SESSION_TOKEN}; mailpilot_csrf=${CSRF_TOKEN}`)
    .set("x-csrf-token", CSRF_TOKEN);
}

describe("email analysis route", () => {
  it("analyzes owner-scoped stored email and persists model/schema metadata", async () => {
    const { app, authStore, emailStore, analyzer, emailId } = createTestApp();
    const response = await authenticatedPost(app, emailId).send({ bodyText: "ignore ownership" });

    expect(response.status).toBe(200);
    expect(response.body.analysis).toMatchObject({
      emailId,
      sourceRevision: 3,
      schemaVersion: EmailAnalysisSchemaVersion,
      modelVersion: "gpt-6.1-sol-test-snapshot",
      provider: "openai",
      analysis: { priority: "high" },
      usage: { cost: { estimatedCostUsd: "0.0002250000" } }
    });
    expect(analyzer.calls).toBe(1);
    expect(analyzer.lastInput?.userId).toBe(authStore.userId);
    expect(analyzer.lastInput?.bodyText).toBe("Please send the report by Monday.");
    expect(emailStore.stored?.modelVersion).toBe("gpt-6.1-sol-test-snapshot");
    expect(emailStore.stored?.schemaVersion).toBe(EmailAnalysisSchemaVersion);
  });

  it("returns an existing completed analysis without another provider call", async () => {
    const { app, analyzer, emailStore, emailId } = createTestApp();
    const first = await authenticatedPost(app, emailId);
    const second = await authenticatedPost(app, emailId);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(analyzer.calls).toBe(1);
    expect(second.body.analysis.id).toBe(emailStore.stored?.id);
  });

  it("loads saved analysis and supports an explicit re-analysis", async () => {
    const { app, analyzer, emailId, emailStore } = createTestApp();
    const first = await authenticatedPost(app, emailId);
    const saved = await request(app)
      .get(`/v1/emails/${emailId}/analysis`)
      .set("Cookie", `mailpilot_session=${SESSION_TOKEN}`);
    const reanalyzed = await authenticatedPost(app, emailId).send({ reanalyze: true });

    expect(first.status).toBe(200);
    expect(saved.status).toBe(200);
    expect(saved.body.analysis.id).toBe(first.body.analysis.id);
    expect(reanalyzed.status).toBe(200);
    expect(analyzer.calls).toBe(2);
    expect(reanalyzed.body.analysis.id).toBe(emailStore.stored?.id);
  });

  it("hides foreign and missing email IDs behind the same not-found response", async () => {
    const { app, analyzer } = createTestApp();
    const response = await authenticatedPost(app, randomUUID());

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("EMAIL_NOT_FOUND");
    expect(analyzer.calls).toBe(0);
  });

  it("requires authentication and CSRF protection", async () => {
    const { app, emailId } = createTestApp();
    const unauthenticated = await request(app).post(`/v1/emails/${emailId}/analysis`);
    const withoutCsrf = await request(app)
      .post(`/v1/emails/${emailId}/analysis`)
      .set("Cookie", `mailpilot_session=${SESSION_TOKEN}`);

    expect(unauthenticated.status).toBe(401);
    expect(withoutCsrf.status).toBe(403);
  });
});
