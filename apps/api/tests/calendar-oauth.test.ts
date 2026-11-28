import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import request from "supertest";
import { GoogleCalendarScope } from "@mailpilot/shared";
import { createApp } from "../src/app.js";
import { hashSecret } from "../src/auth/cookies.js";
import type {
  AuthStore,
  GoogleOidcClient,
  SessionRecord
} from "../src/auth/types.js";
import type { GoogleCalendarOAuthClient } from "../src/calendar/google-oauth.js";
import type {
  ConnectGoogleCalendarInput,
  GoogleCalendarConnectionRecord,
  GoogleCalendarConnectionStore
} from "../src/calendar/types.js";

const WEB_ORIGIN = "http://localhost:3000";

class MemoryAuthStore implements AuthStore {
  public readonly sessions = new Map<string, SessionRecord>();

  public async authenticateGoogleIdentity(): Promise<{ id: string; emailNormalized: string; status: "active" }> {
    throw new Error("not used by Calendar OAuth tests");
  }

  public async createSession(): Promise<{ id: string }> {
    throw new Error("not used by Calendar OAuth tests");
  }

  public async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return this.sessions.get(tokenHash) ?? null;
  }

  public async revokeSession(sessionId: string, userId: string, revokedAt: Date): Promise<void> {
    for (const [tokenHash, session] of this.sessions) {
      if (session.id === sessionId && session.userId === userId) {
        this.sessions.set(tokenHash, { ...session, revokedAt });
      }
    }
  }

  public seedSession(token: string, userId: string, email: string): SessionRecord {
    const session: SessionRecord = {
      id: randomUUID(),
      userId,
      csrfTokenHash: hashSecret("csrf-token-value-that-is-long-enough"),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      user: { emailNormalized: email, status: "active" }
    };
    this.sessions.set(hashSecret(token), session);
    return session;
  }
}

class FakeOidcClient implements GoogleOidcClient {
  public async buildAuthorizationUrl(): Promise<URL> {
    return new URL("https://accounts.google.com/o/oauth2/v2/auth");
  }

  public async exchangeAuthorizationCode(): Promise<{ subject: string; email: string; emailVerified: boolean }> {
    throw new Error("not used by Calendar OAuth tests");
  }
}

class MemoryCalendarStore implements GoogleCalendarConnectionStore {
  public readonly connections = new Map<string, GoogleCalendarConnectionRecord>();
  public readonly connectCalendar = vi.fn(async (input: ConnectGoogleCalendarInput) => {
    const record: GoogleCalendarConnectionRecord = {
      id: randomUUID(),
      userId: input.userId,
      providerSubject: input.subject,
      email: input.email,
      status: "active",
      grantedScopes: input.grantedScopes,
      connectedAt: input.connectedAt,
      disconnectedAt: null
    };
    this.connections.set(input.userId, record);
    return record;
  });

  public async getConnection(userId: string): Promise<GoogleCalendarConnectionRecord | null> {
    return this.connections.get(userId) ?? null;
  }

  public async getDecryptedRefreshToken(): Promise<string | null> {
    return null;
  }

  public async markReauthRequired(): Promise<void> {}

  public async disconnectCalendar(userId: string, disconnectedAt: Date): Promise<void> {
    const existing = this.connections.get(userId);
    if (existing) this.connections.set(userId, { ...existing, status: "disconnected", disconnectedAt });
  }
}

class FakeCalendarOAuthClient implements GoogleCalendarOAuthClient {
  public state: string | undefined;
  public exchangeCount = 0;

  public async buildAuthorizationUrl(input: { state: string }): Promise<URL> {
    this.state = input.state;
    return new URL("https://accounts.google.com/o/oauth2/v2/auth");
  }

  public async exchangeAuthorizationCode(): Promise<{
    subject: string;
    email: string;
    emailVerified: boolean;
    refreshToken: string;
    grantedScopes: string[];
  }> {
    this.exchangeCount += 1;
    return {
      subject: "calendar-google-subject",
      email: "calendar@example.test",
      emailVerified: true,
      refreshToken: "refresh-token",
      grantedScopes: [GoogleCalendarScope]
    };
  }

  public async refreshAccessToken(): Promise<{ accessToken: string; expiresInSeconds: number }> {
    return { accessToken: "access-token", expiresInSeconds: 3600 };
  }

  public async revokeToken(): Promise<void> {}
}

function cookies(header: string | string[] | undefined): string[] {
  return Array.isArray(header) ? header : header ? [header] : [];
}

function cookiePair(cookiesToSearch: string[], name: string): string {
  const cookie = cookiesToSearch.find((candidate) => candidate.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Expected ${name} cookie`);
  return cookie.split(";", 1)[0] ?? cookie;
}

describe("Google Calendar OAuth session binding", () => {
  it("rejects a callback completed in a different session from the one that started OAuth", async () => {
    const authStore = new MemoryAuthStore();
    const calendarStore = new MemoryCalendarStore();
    const oauthClient = new FakeCalendarOAuthClient();
    const ownerId = randomUUID();
    const otherUserId = randomUUID();
    const ownerToken = "o".repeat(43);
    const otherToken = "x".repeat(43);
    authStore.seedSession(ownerToken, ownerId, "owner@example.test");
    authStore.seedSession(otherToken, otherUserId, "other@example.test");
    const app = createApp({
      checkDatabase: async () => undefined,
      authStore,
      oidcClient: new FakeOidcClient(),
      calendarStore,
      calendarOAuthClient: oauthClient,
      logger: pino({ level: "silent" })
    });

    const start = await request(app)
      .get("/v1/calendar/connect")
      .set("Cookie", `mailpilot_session=${ownerToken}`);
    expect(start.status).toBe(302);
    const transactionCookie = cookiePair(cookies(start.headers["set-cookie"]), "mailpilot_calendar_oauth");
    const state = oauthClient.state;
    expect(state).toBeDefined();

    const callback = await request(app)
      .get(`/v1/oauth/google-calendar/callback?code=fake-code&state=${encodeURIComponent(state ?? "")}`)
      .set("Cookie", `${transactionCookie}; mailpilot_session=${otherToken}`);

    expect(callback.status).toBe(303);
    expect(callback.headers.location).toBe(`${WEB_ORIGIN}/settings?calendar_error=invalid_state`);
    expect(oauthClient.exchangeCount).toBe(0);
    expect(calendarStore.connectCalendar).not.toHaveBeenCalled();
    expect(calendarStore.connections.size).toBe(0);
  });
});
