import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import pino from "pino";
import request from "supertest";
import { createApp } from "../src/app.js";
import { hashSecret } from "../src/auth/cookies.js";
import type { AuthStore, CreateSessionInput, GoogleIdentity, GoogleOidcClient, OAuthChecks, SessionRecord } from "../src/auth/types.js";

const WEB_ORIGIN = "http://localhost:3000";
const GOOGLE_IDENTITY: GoogleIdentity = {
  subject: "google-subject-1",
  email: "person@gmail.com",
  emailVerified: true
};

class MemoryAuthStore implements AuthStore {
  public readonly userId = randomUUID();
  public readonly sessions = new Map<string, SessionRecord>();

  public async authenticateGoogleIdentity(): Promise<{ id: string; emailNormalized: string; status: "active" }> {
    return { id: this.userId, emailNormalized: GOOGLE_IDENTITY.email, status: "active" };
  }

  public async createSession(input: CreateSessionInput): Promise<{ id: string }> {
    const id = randomUUID();
    this.sessions.set(input.tokenHash, {
      id,
      userId: input.userId,
      csrfTokenHash: input.csrfTokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
      user: { emailNormalized: GOOGLE_IDENTITY.email, status: "active" }
    });
    return { id };
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

  public seedSession(token: string, expiresAt: Date): void {
    this.seedSessionForUser(
      token,
      this.userId,
      GOOGLE_IDENTITY.email,
      "csrf-token-value-that-is-long-enough",
      expiresAt
    );
  }

  public seedSessionForUser(token: string, userId: string, email: string, csrfToken: string, expiresAt: Date): SessionRecord {
    const session: SessionRecord = {
      id: randomUUID(),
      userId,
      csrfTokenHash: hashSecret(csrfToken),
      expiresAt,
      revokedAt: null,
      user: { emailNormalized: email, status: "active" }
    };
    this.sessions.set(hashSecret(token), session);
    return session;
  }

}

class FakeGoogleOidcClient implements GoogleOidcClient {
  public lastAuthorization: (OAuthChecks & { redirectUri: string; scope: string }) | undefined;
  public lastChecks: OAuthChecks | undefined;
  public identity: GoogleIdentity = GOOGLE_IDENTITY;

  public async buildAuthorizationUrl(input: OAuthChecks & { redirectUri: string; scope: string }): Promise<URL> {
    this.lastAuthorization = input;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("state", input.state);
    url.searchParams.set("nonce", input.nonce);
    url.searchParams.set("scope", input.scope);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  }

  public async exchangeAuthorizationCode(_callbackUrl: URL, checks: OAuthChecks): Promise<GoogleIdentity> {
    this.lastChecks = checks;
    return this.identity;
  }
}

function createTestApp(store = new MemoryAuthStore(), oidc = new FakeGoogleOidcClient()) {
  const app = createApp({
    checkDatabase: async () => undefined,
    authStore: store,
    oidcClient: oidc,
    logger: pino({ level: "silent" })
  });
  return { app, store, oidc };
}

function findCookie(cookies: string[], name: string): string {
  const cookie = cookies.find((candidate) => candidate.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Expected ${name} cookie.`);
  return cookie;
}

function getResponseCookies(header: string | string[] | undefined): string[] {
  if (Array.isArray(header)) return header;
  return header ? [header] : [];
}

function cookiePair(cookies: string[], name: string): string {
  const cookie = findCookie(cookies, name);
  const separator = cookie.indexOf(";");
  return separator === -1 ? cookie : cookie.slice(0, separator);
}

describe("application authentication", () => {
  it("rejects unauthorized API access while leaving health endpoints public", async () => {
    const { app } = createTestApp();
    const unauthorized = await request(app).get("/v1");
    const protectedUnknownRoute = await request(app).get("/v1/future-resource");
    const missingSession = await request(app).get("/v1/auth/session");
    const health = await request(app).get("/health/live");

    expect(unauthorized.status).toBe(401);
    expect(protectedUnknownRoute.status).toBe(401);
    expect(missingSession.status).toBe(401);
    expect(unauthorized.body.error).toMatchObject({ code: "UNAUTHORIZED", retryable: false });
    expect(health.status).toBe(200);
  });

  it("derives authority from the session and cannot revoke another user's session by ID", async () => {
    const store = new MemoryAuthStore();
    const firstUserId = randomUUID();
    const secondUserId = randomUUID();
    const firstToken = "a".repeat(43);
    const secondToken = "b".repeat(43);
    const firstCsrf = "csrf-token-user-one-with-enough-bytes";
    const secondCsrf = "csrf-token-user-two-with-enough-bytes";
    const firstSession = store.seedSessionForUser(
      firstToken,
      firstUserId,
      "first-user@gmail.com",
      firstCsrf,
      new Date(Date.now() + 60_000)
    );
    const secondSession = store.seedSessionForUser(
      secondToken,
      secondUserId,
      "second-user@gmail.com",
      secondCsrf,
      new Date(Date.now() + 60_000)
    );
    const { app } = createTestApp(store);

    const firstIdentity = await request(app)
      .get(`/v1/auth/session?userId=${secondUserId}&role=administrator`)
      .set("Cookie", `mailpilot_session=${firstToken}`)
      .set("x-user-id", secondUserId)
      .set("x-role", "administrator");

    expect(firstIdentity.status).toBe(200);
    expect(firstIdentity.body.user).toEqual({ id: firstUserId, email: "first-user@gmail.com" });

    const forgedSignOut = await request(app)
      .post("/v1/auth/sign-out")
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", `mailpilot_session=${firstToken}; mailpilot_csrf=${firstCsrf}`)
      .set("x-csrf-token", firstCsrf)
      .send({
        userId: secondUserId,
        sessionId: secondSession.id,
        role: "administrator",
        actorType: "administrator"
      });

    expect(forgedSignOut.status).toBe(204);
    expect(store.sessions.get(hashSecret(firstToken))?.revokedAt).toBeInstanceOf(Date);
    expect(store.sessions.get(hashSecret(secondToken))?.revokedAt).toBeNull();

    const secondIdentity = await request(app)
      .get("/v1/auth/session")
      .set("Cookie", `mailpilot_session=${secondToken}`);
    expect(secondIdentity.status).toBe(200);
    expect(secondIdentity.body.user).toEqual({ id: secondUserId, email: "second-user@gmail.com" });

    const foreignRecordIdAsToken = await request(app)
      .get("/v1/auth/session")
      .set("Cookie", `mailpilot_session=${secondSession.id}`);
    expect(foreignRecordIdAsToken.status).toBe(401);
    expect(store.sessions.get(hashSecret(secondToken))?.id).toBe(secondSession.id);
    expect(store.sessions.get(hashSecret(firstToken))?.id).toBe(firstSession.id);
  });

  it("completes Google sign-in, enforces the session, and revokes it on sign-out", async () => {
    const { app, store, oidc } = createTestApp();
    const start = await request(app).get("/v1/auth/google/start?returnTo=%2Finbox");
    const startCookies = getResponseCookies(start.headers["set-cookie"]);
    const loginCookie = cookiePair(startCookies, "mailpilot_login");
    const state = oidc.lastAuthorization?.state;

    expect(start.status).toBe(302);
    expect(new URL(start.headers.location as string).searchParams.get("scope")).toBe("openid email");
    expect(oidc.lastAuthorization?.redirectUri).toBe("http://localhost:4000/v1/auth/google/callback");
    expect(oidc.lastAuthorization?.scope).not.toContain("gmail");
    expect(findCookie(startCookies, "mailpilot_login")).toContain("HttpOnly");
    expect(findCookie(startCookies, "mailpilot_login")).toContain("SameSite=Lax");
    expect(state).toBeDefined();

    const callback = await request(app)
      .get(`/v1/auth/google/callback?code=one-time-code&state=${encodeURIComponent(state ?? "")}`)
      .set("Cookie", loginCookie);
    const callbackCookies = getResponseCookies(callback.headers["set-cookie"]);
    const sessionCookie = cookiePair(callbackCookies, "mailpilot_session");
    const csrfCookie = cookiePair(callbackCookies, "mailpilot_csrf");
    const sessionToken = sessionCookie.slice("mailpilot_session=".length);
    const csrfToken = csrfCookie.slice("mailpilot_csrf=".length);

    expect(callback.status).toBe(303);
    expect(callback.headers.location).toBe(`${WEB_ORIGIN}/inbox`);
    expect(oidc.lastChecks).toMatchObject({ state, nonce: oidc.lastAuthorization?.nonce });
    expect(findCookie(callbackCookies, "mailpilot_session")).toContain("HttpOnly");
    expect(findCookie(callbackCookies, "mailpilot_session")).toContain("SameSite=Lax");
    expect(findCookie(callbackCookies, "mailpilot_session")).toContain("Max-Age=28800");
    expect(findCookie(callbackCookies, "mailpilot_csrf")).toContain("SameSite=Strict");
    expect(findCookie(callbackCookies, "mailpilot_csrf")).not.toContain("HttpOnly");
    expect(store.sessions.has(hashSecret(sessionToken))).toBe(true);

    const session = await request(app).get("/v1/auth/session").set("Cookie", sessionCookie);
    expect(session.status).toBe(200);
    expect(session.body).toEqual({ user: { id: store.userId, email: GOOGLE_IDENTITY.email } });
    expect(session.headers["cache-control"]).toBe("no-store");

    const rejectedCsrf = await request(app)
      .post("/v1/auth/sign-out")
      .set("Origin", "https://attacker.example")
      .set("Cookie", `${sessionCookie}; ${csrfCookie}`)
      .set("x-csrf-token", csrfToken);
    expect(rejectedCsrf.status).toBe(403);

    const signedOut = await request(app)
      .post("/v1/auth/sign-out")
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", `${sessionCookie}; ${csrfCookie}`)
      .set("x-csrf-token", csrfToken);
    expect(signedOut.status).toBe(204);
    expect(findCookie(getResponseCookies(signedOut.headers["set-cookie"]), "mailpilot_session")).toContain("Max-Age=0");

    const afterSignOut = await request(app).get("/v1/auth/session").set("Cookie", sessionCookie);
    expect(afterSignOut.status).toBe(401);
    expect(Array.from(store.sessions.values()).every((saved) => saved.revokedAt !== null)).toBe(true);
  });

  it("expires and revokes stale database sessions", async () => {
    const store = new MemoryAuthStore();
    const expiredToken = "e".repeat(43);
    store.seedSession(expiredToken, new Date(Date.now() - 1000));
    const { app } = createTestApp(store);

    const response = await request(app)
      .get("/v1/auth/session")
      .set("Cookie", `mailpilot_session=${expiredToken}`);

    expect(response.status).toBe(401);
    expect(findCookie(getResponseCookies(response.headers["set-cookie"]), "mailpilot_session")).toContain("Max-Age=0");
    expect(Array.from(store.sessions.values())[0]?.revokedAt).toBeInstanceOf(Date);
  });
});
