import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import pino from "pino";
import request from "supertest";
import { createApp } from "../src/app.js";
import type { GmailSyncService } from "../src/gmail/sync-service.js";
import { hashSecret } from "../src/auth/cookies.js";
import type {
  AuthStore,
  CreateSessionInput,
  GoogleIdentity,
  GoogleOidcClient,
  OAuthChecks,
  SessionRecord
} from "../src/auth/types.js";
import { decryptRefreshToken, encryptRefreshToken } from "../src/gmail/token-encryption.js";
import type {
  ConnectGmailInput,
  GmailConnectionRecord,
  GmailConnectionStore,
  GmailOAuthChecks,
  GmailOAuthClient,
  GmailTokenExchange
} from "../src/gmail/types.js";

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

  public seedSessionForUser(
    token: string,
    userId: string,
    email: string,
    csrfToken: string,
    expiresAt: Date
  ): SessionRecord {
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
  public async buildAuthorizationUrl(input: OAuthChecks & { redirectUri: string; scope: string }): Promise<URL> {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("state", input.state);
    return url;
  }

  public async exchangeAuthorizationCode(): Promise<GoogleIdentity> {
    return GOOGLE_IDENTITY;
  }
}

class MemoryGmailConnectionStore implements GmailConnectionStore {
  public connections = new Map<string, GmailConnectionRecord>();
  public refreshTokens = new Map<string, string>();

  public async connectGmail(input: ConnectGmailInput): Promise<GmailConnectionRecord> {
    const existing = this.connections.get(input.userId);
    const id = existing?.id ?? randomUUID();
    const record: GmailConnectionRecord = {
      id,
      userId: input.userId,
      providerSubject: input.subject,
      providerEmailNormalized: input.email,
      status: "active",
      grantedScopes: input.grantedScopes,
      connectedAt: input.connectedAt,
      disconnectedAt: null,
      lastSuccessfulSyncAt: null
    };
    this.connections.set(input.userId, record);
    if (input.refreshToken) {
      this.refreshTokens.set(input.userId, input.refreshToken);
    }
    return record;
  }

  public async getConnection(userId: string): Promise<GmailConnectionRecord | null> {
    return this.connections.get(userId) ?? null;
  }

  public async getDecryptedRefreshToken(userId: string): Promise<string | null> {
    const conn = this.connections.get(userId);
    if (!conn || conn.status === "disconnected") return null;
    return this.refreshTokens.get(userId) ?? null;
  }

  public async markReauthRequired(userId: string): Promise<void> {
    const existing = this.connections.get(userId);
    if (existing) {
      this.connections.set(userId, { ...existing, status: "reauth_required" });
    }
  }

  public async disconnectGmail(userId: string, disconnectedAt: Date): Promise<void> {
    const existing = this.connections.get(userId);
    if (existing) {
      this.connections.set(userId, {
        ...existing,
        status: "disconnected",
        disconnectedAt
      });
      this.refreshTokens.delete(userId);
    }
  }
}

class FakeGoogleGmailOAuthClient implements GmailOAuthClient {
  public lastAuthorization: (GmailOAuthChecks & { redirectUri: string; scope: string }) | undefined;
  public lastChecks: GmailOAuthChecks | undefined;
  public exchangeCount = 0;
  public revokedTokens: string[] = [];
  public exchangeResult: GmailTokenExchange = {
    subject: "gmail-google-subject-1",
    email: "connected.user@gmail.com",
    emailVerified: true,
    refreshToken: "1//04fake-refresh-token-value",
    grantedScopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"]
  };

  public async buildAuthorizationUrl(input: GmailOAuthChecks & { redirectUri: string; scope: string }): Promise<URL> {
    this.lastAuthorization = input;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("state", input.state);
    url.searchParams.set("nonce", input.nonce);
    url.searchParams.set("scope", input.scope);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("access_type", "offline");
    return url;
  }

  public async exchangeAuthorizationCode(_callbackUrl: URL, checks: GmailOAuthChecks): Promise<GmailTokenExchange> {
    this.lastChecks = checks;
    this.exchangeCount += 1;
    return this.exchangeResult;
  }

  public async refreshAccessToken(): Promise<{ accessToken: string; expiresInSeconds: number }> {
    return { accessToken: "refreshed-token", expiresInSeconds: 3600 };
  }

  public async revokeToken(token: string): Promise<void> {
    this.revokedTokens.push(token);
  }
}

function createTestApp(
  authStore = new MemoryAuthStore(),
  gmailStore = new MemoryGmailConnectionStore(),
  gmailOAuthClient = new FakeGoogleGmailOAuthClient()
) {
  const app = createApp({
    checkDatabase: async () => undefined,
    authStore,
    oidcClient: new FakeGoogleOidcClient(),
    gmailStore,
    gmailOAuthClient,
    gmailSyncService: {
      async cancelActiveForConnection() {}
    } as unknown as GmailSyncService,
    logger: pino({ level: "silent" })
  });
  return { app, authStore, gmailStore, gmailOAuthClient };
}

function getResponseCookies(header: string | string[] | undefined): string[] {
  if (Array.isArray(header)) return header;
  return header ? [header] : [];
}

function findCookie(cookies: string[], name: string): string {
  const cookie = cookies.find((candidate) => candidate.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Expected ${name} cookie.`);
  return cookie;
}

function cookiePair(cookies: string[], name: string): string {
  const cookie = findCookie(cookies, name);
  const separator = cookie.indexOf(";");
  return separator === -1 ? cookie : cookie.slice(0, separator);
}

describe("Gmail token encryption", () => {
  const rawKey = "local-replace-with-base64-encoded-32-byte-key";

  it("encrypts and decrypts refresh tokens faithfully using AES-256-GCM", () => {
    const token = "1//04test_refresh_token_value_abc123";
    const encrypted = encryptRefreshToken(token, rawKey);

    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.nonce.length).toBe(16); // 12 bytes base64url = 16 chars
    expect(encrypted.authTag.length).toBe(22); // 16 bytes base64url = 22 chars
    expect(encrypted.keyVersion).toBe("v1");

    const decrypted = decryptRefreshToken(encrypted, rawKey);
    expect(decrypted).toBe(token);
  });

  it("fails decryption if ciphertext or auth tag is tampered", () => {
    const encrypted = encryptRefreshToken("secret-token", rawKey);
    const tamperedCiphertext = { ...encrypted, ciphertext: "bad" + encrypted.ciphertext.slice(3) };
    expect(() => decryptRefreshToken(tamperedCiphertext, rawKey)).toThrow();

    const tamperedTag = { ...encrypted, authTag: "bad" + encrypted.authTag.slice(3) };
    expect(() => decryptRefreshToken(tamperedTag, rawKey)).toThrow();
  });
});

describe("Gmail OAuth connection flow", () => {
  it("rejects unauthenticated requests to start Gmail connect", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/v1/gmail/connect");
    expect(response.status).toBe(401);
  });

  it("initiates Gmail OAuth with minimum read-only scope and PKCE protection", async () => {
    const { app, authStore, gmailOAuthClient } = createTestApp();
    const sessionToken = "s".repeat(43);
    const csrfToken = "c".repeat(43);
    authStore.seedSessionForUser(
      sessionToken,
      authStore.userId,
      "user@gmail.com",
      csrfToken,
      new Date(Date.now() + 60_000)
    );

    const start = await request(app)
      .get("/v1/gmail/connect?returnTo=%2Fsettings")
      .set("Cookie", `mailpilot_session=${sessionToken}`);

    expect(start.status).toBe(302);
    const location = new URL(start.headers.location as string);
    expect(location.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/gmail.readonly");
    expect(location.searchParams.get("scope")).not.toContain("mail.google.com");
    expect(location.searchParams.get("scope")).not.toContain("gmail.modify");
    expect(location.searchParams.get("scope")).not.toContain("gmail.send");
    expect(location.searchParams.get("prompt")).toBe("consent");
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");

    const startCookies = getResponseCookies(start.headers["set-cookie"]);
    const oauthCookie = findCookie(startCookies, "mailpilot_gmail_oauth");
    expect(oauthCookie).toContain("HttpOnly");
    expect(oauthCookie).toContain("SameSite=Lax");
    expect(gmailOAuthClient.lastAuthorization?.redirectUri).toBe("http://localhost:4000/v1/oauth/google/callback");
  });

  it("completes Gmail OAuth callback and stores connection metadata securely", async () => {
    const { app, authStore, gmailStore, gmailOAuthClient } = createTestApp();
    const sessionToken = "s".repeat(43);
    const csrfToken = "c".repeat(43);
    authStore.seedSessionForUser(
      sessionToken,
      authStore.userId,
      "user@gmail.com",
      csrfToken,
      new Date(Date.now() + 60_000)
    );

    const start = await request(app)
      .get("/v1/gmail/connect?returnTo=%2Fsettings")
      .set("Cookie", `mailpilot_session=${sessionToken}`);

    const startCookies = getResponseCookies(start.headers["set-cookie"]);
    const oauthCookie = cookiePair(startCookies, "mailpilot_gmail_oauth");
    const state = gmailOAuthClient.lastAuthorization?.state;
    expect(state).toBeDefined();

    const callback = await request(app)
      .get(`/v1/oauth/google/callback?code=fake-auth-code&state=${encodeURIComponent(state ?? "")}`)
      .set("Cookie", `${oauthCookie}; mailpilot_session=${sessionToken}`);

    expect(callback.status).toBe(303);
    expect(callback.headers.location).toBe(`${WEB_ORIGIN}/settings?gmail=connected`);

    // The transaction cookie must be expired on callback
    const callbackCookies = getResponseCookies(callback.headers["set-cookie"]);
    expect(findCookie(callbackCookies, "mailpilot_gmail_oauth")).toContain("Max-Age=0");

    // Connection must be recorded in store
    const connection = await gmailStore.getConnection(authStore.userId);
    expect(connection).not.toBeNull();
    expect(connection?.status).toBe("active");
    expect(connection?.providerEmailNormalized).toBe("connected.user@gmail.com");
    expect(connection?.grantedScopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(gmailStore.refreshTokens.get(authStore.userId)).toBe("1//04fake-refresh-token-value");

    // GET /v1/gmail/connection reports status without leaking token material
    const statusResponse = await request(app)
      .get("/v1/gmail/connection")
      .set("Cookie", `mailpilot_session=${sessionToken}`);

    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body.connection).toMatchObject({
      email: "connected.user@gmail.com",
      status: "active",
      grantedScopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
      reauthRequired: false
    });
    expect(JSON.stringify(statusResponse.body)).not.toContain("fake-refresh-token");
    expect(JSON.stringify(statusResponse.body)).not.toContain("ciphertext");
  });

  it("handles user cancellation on Google consent screen cleanly", async () => {
    const { app, authStore, gmailOAuthClient } = createTestApp();
    const sessionToken = "s".repeat(43);
    authStore.seedSessionForUser(sessionToken, authStore.userId, "u@gmail.com", "c".repeat(43), new Date(Date.now() + 60_000));

    const start = await request(app)
      .get("/v1/gmail/connect?returnTo=%2Fsettings")
      .set("Cookie", `mailpilot_session=${sessionToken}`);
    const startCookies = getResponseCookies(start.headers["set-cookie"]);
    const oauthCookie = cookiePair(startCookies, "mailpilot_gmail_oauth");
    const state = gmailOAuthClient.lastAuthorization?.state;

    const callback = await request(app)
      .get(`/v1/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state ?? "")}`)
      .set("Cookie", `${oauthCookie}; mailpilot_session=${sessionToken}`);

    expect(callback.status).toBe(303);
    expect(callback.headers.location).toBe(`${WEB_ORIGIN}/settings?error=access_denied`);
  });

  it("handles provider error on Google consent screen", async () => {
    const { app, authStore, gmailOAuthClient } = createTestApp();
    const sessionToken = "s".repeat(43);
    authStore.seedSessionForUser(sessionToken, authStore.userId, "u@gmail.com", "c".repeat(43), new Date(Date.now() + 60_000));

    const start = await request(app)
      .get("/v1/gmail/connect?returnTo=%2Fsettings")
      .set("Cookie", `mailpilot_session=${sessionToken}`);
    const startCookies = getResponseCookies(start.headers["set-cookie"]);
    const oauthCookie = cookiePair(startCookies, "mailpilot_gmail_oauth");
    const state = gmailOAuthClient.lastAuthorization?.state;

    const callback = await request(app)
      .get(`/v1/oauth/google/callback?error=server_error&state=${encodeURIComponent(state ?? "")}`)
      .set("Cookie", `${oauthCookie}; mailpilot_session=${sessionToken}`);

    expect(callback.status).toBe(303);
    expect(callback.headers.location).toBe(`${WEB_ORIGIN}/settings?error=oauth_failed`);
  });

  it("rejects callbacks with tampered state or missing cookie", async () => {
    const { app } = createTestApp();

    const missingCookie = await request(app)
      .get("/v1/oauth/google/callback?code=some-code&state=fake-state");
    expect(missingCookie.status).toBe(303);
    expect(missingCookie.headers.location).toBe(`${WEB_ORIGIN}/settings?error=invalid_state`);

    const mismatchedState = await request(app)
      .get("/v1/oauth/google/callback?code=some-code&state=mismatched-state")
      .set("Cookie", "mailpilot_gmail_oauth=tampered.cookie");
    expect(mismatchedState.status).toBe(303);
    expect(mismatchedState.headers.location).toBe(`${WEB_ORIGIN}/settings?error=invalid_state`);
  });

  it("does not bind a Gmail grant to a different session than the one that started OAuth", async () => {
    const { app, authStore, gmailStore, gmailOAuthClient } = createTestApp();
    const ownerToken = "o".repeat(43);
    const otherToken = "x".repeat(43);
    authStore.seedSessionForUser(ownerToken, authStore.userId, "owner@gmail.com", "c1", new Date(Date.now() + 60_000));
    const otherUserId = randomUUID();
    authStore.seedSessionForUser(otherToken, otherUserId, "other@gmail.com", "c2", new Date(Date.now() + 60_000));

    const start = await request(app)
      .get("/v1/gmail/connect")
      .set("Cookie", `mailpilot_session=${ownerToken}`);
    const oauthCookie = cookiePair(getResponseCookies(start.headers["set-cookie"]), "mailpilot_gmail_oauth");
    const state = gmailOAuthClient.lastAuthorization?.state;

    const callback = await request(app)
      .get(`/v1/oauth/google/callback?code=fake-auth-code&state=${encodeURIComponent(state ?? "")}`)
      .set("Cookie", `${oauthCookie}; mailpilot_session=${otherToken}`);

    expect(callback.headers.location).toBe(`${WEB_ORIGIN}/settings?error=invalid_state`);
    expect(gmailOAuthClient.exchangeCount).toBe(0);
    expect(await gmailStore.getConnection(authStore.userId)).toBeNull();
    expect(await gmailStore.getConnection(otherUserId)).toBeNull();
  });

  it("rejects unverified Gmail identities and grants missing the read-only scope", async () => {
    for (const exchangeResult of [
      {
        subject: "unverified-subject",
        email: "unverified@gmail.com",
        emailVerified: false,
        refreshToken: "refresh-token",
        grantedScopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"]
      },
      {
        subject: "missing-scope-subject",
        email: "missing-scope@gmail.com",
        emailVerified: true,
        refreshToken: "refresh-token",
        grantedScopes: ["openid", "email"]
      }
    ]) {
      const { app, authStore, gmailStore, gmailOAuthClient } = createTestApp();
      gmailOAuthClient.exchangeResult = exchangeResult;
      const sessionToken = "s".repeat(43);
      authStore.seedSessionForUser(sessionToken, authStore.userId, "user@gmail.com", "csrf", new Date(Date.now() + 60_000));
      const start = await request(app)
        .get("/v1/gmail/connect")
        .set("Cookie", `mailpilot_session=${sessionToken}`);
      const oauthCookie = cookiePair(getResponseCookies(start.headers["set-cookie"]), "mailpilot_gmail_oauth");
      const state = gmailOAuthClient.lastAuthorization?.state;

      const callback = await request(app)
        .get(`/v1/oauth/google/callback?code=fake-auth-code&state=${encodeURIComponent(state ?? "")}`)
        .set("Cookie", `${oauthCookie}; mailpilot_session=${sessionToken}`);

      expect(callback.status).toBe(303);
      expect(await gmailStore.getConnection(authStore.userId)).toBeNull();
    }
  });

  it("isolates connection status across different users", async () => {
    const { app, authStore, gmailStore } = createTestApp();
    const userOneId = authStore.userId;
    const userTwoId = randomUUID();
    const tokenOne = "1".repeat(43);
    const tokenTwo = "2".repeat(43);

    authStore.seedSessionForUser(tokenOne, userOneId, "one@gmail.com", "c1", new Date(Date.now() + 60_000));
    authStore.seedSessionForUser(tokenTwo, userTwoId, "two@gmail.com", "c2", new Date(Date.now() + 60_000));

    // Connect user one
    await gmailStore.connectGmail({
      userId: userOneId,
      subject: "sub-1",
      email: "userone@gmail.com",
      refreshToken: "refresh-1",
      grantedScopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
      connectedAt: new Date()
    });

    // User one sees their connection
    const userOneStatus = await request(app)
      .get("/v1/gmail/connection")
      .set("Cookie", `mailpilot_session=${tokenOne}`);
    expect(userOneStatus.status).toBe(200);
    expect(userOneStatus.body.connection?.email).toBe("userone@gmail.com");

    // User two sees null connection
    const userTwoStatus = await request(app)
      .get("/v1/gmail/connection")
      .set("Cookie", `mailpilot_session=${tokenTwo}`);
    expect(userTwoStatus.status).toBe(200);
    expect(userTwoStatus.body.connection).toBeNull();
  });

  it("disconnects Gmail connection, revokes token, and clears credentials", async () => {
    const { app, authStore, gmailStore, gmailOAuthClient } = createTestApp();
    const sessionToken = "s".repeat(43);
    const csrfToken = "csrf-token-long-enough-for-validation";
    authStore.seedSessionForUser(
      sessionToken,
      authStore.userId,
      "user@gmail.com",
      csrfToken,
      new Date(Date.now() + 60_000)
    );

    await gmailStore.connectGmail({
      userId: authStore.userId,
      subject: "sub-1",
      email: "user@gmail.com",
      refreshToken: "refresh-token-to-revoke",
      grantedScopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
      connectedAt: new Date()
    });

    // Reject disconnect without CSRF
    const rejectedNoCsrf = await request(app)
      .delete("/v1/gmail/connection")
      .set("Cookie", `mailpilot_session=${sessionToken}`);
    expect(rejectedNoCsrf.status).toBe(403);

    // Disconnect with valid session and CSRF
    const disconnectResponse = await request(app)
      .delete("/v1/gmail/connection")
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", `mailpilot_session=${sessionToken}; mailpilot_csrf=${csrfToken}`)
      .set("x-csrf-token", csrfToken);

    expect(disconnectResponse.status, JSON.stringify(disconnectResponse.body)).toBe(204);
    expect(gmailOAuthClient.revokedTokens).toContain("refresh-token-to-revoke");
    expect(gmailStore.refreshTokens.has(authStore.userId)).toBe(false);

    const connection = await gmailStore.getConnection(authStore.userId);
    expect(connection?.status).toBe("disconnected");
    expect(connection?.disconnectedAt).toBeInstanceOf(Date);

    // Subsequent GET returns disconnected status
    const statusAfter = await request(app)
      .get("/v1/gmail/connection")
      .set("Cookie", `mailpilot_session=${sessionToken}`);
    expect(statusAfter.status).toBe(200);
    expect(statusAfter.body.connection?.status).toBe("disconnected");
  });
});

