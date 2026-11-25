import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import {
  GmailApiError,
  GmailNotFoundError,
  GmailRateLimitError,
  GmailReauthRequiredError
} from "../src/gmail/api-errors.js";
import { GmailClient } from "../src/gmail/client.js";
import {
  createRefreshingTokenProvider,
  createStaticTokenProvider,
  type GmailTokenProvider
} from "../src/gmail/token-provider.js";
import type {
  ConnectGmailInput,
  GmailConnectionRecord,
  GmailConnectionStore,
  GmailOAuthClient,
  GmailTokenExchange,
  RefreshedAccessToken
} from "../src/gmail/types.js";

const FAKE_ACCESS_TOKEN = "access-sentinel";
const FAKE_REFRESH_TOKEN = "refresh-sentinel";

class MemoryConnectionStore implements GmailConnectionStore {
  public status: "active" | "reauth_required" | "disconnected" = "active";
  public refreshToken: string | null = FAKE_REFRESH_TOKEN;

  public async connectGmail(input: ConnectGmailInput): Promise<GmailConnectionRecord> {
    this.status = "active";
    this.refreshToken = input.refreshToken ?? null;
    return {
      id: "conn-1",
      userId: input.userId,
      providerSubject: input.subject,
      providerEmailNormalized: input.email,
      status: "active",
      grantedScopes: input.grantedScopes,
      connectedAt: input.connectedAt,
      disconnectedAt: null,
      lastSuccessfulSyncAt: null
    };
  }

  public async getConnection(userId: string): Promise<GmailConnectionRecord | null> {
    return {
      id: "conn-1",
      userId,
      providerSubject: "sub-1",
      providerEmailNormalized: "user@gmail.com",
      status: this.status,
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      connectedAt: new Date(),
      disconnectedAt: null,
      lastSuccessfulSyncAt: null
    };
  }

  public async getDecryptedRefreshToken(): Promise<string | null> {
    return this.refreshToken;
  }

  public async markReauthRequired(): Promise<void> {
    this.status = "reauth_required";
  }

  public async disconnectGmail(): Promise<void> {
    this.status = "disconnected";
    this.refreshToken = null;
  }
}

class FakeOAuthClient implements GmailOAuthClient {
  public refreshCount = 0;
  public nextAccessToken = "refreshed-access-sentinel";
  public shouldFailWithReauth = false;

  public async buildAuthorizationUrl(): Promise<URL> {
    return new URL("https://accounts.google.com");
  }

  public async exchangeAuthorizationCode(): Promise<GmailTokenExchange> {
    return {
      subject: "sub",
      email: "user@gmail.com",
      emailVerified: true,
      refreshToken: FAKE_REFRESH_TOKEN,
      grantedScopes: []
    };
  }

  public async refreshAccessToken(): Promise<RefreshedAccessToken> {
    this.refreshCount += 1;
    if (this.shouldFailWithReauth) {
      throw new GmailReauthRequiredError("Refresh token revoked.");
    }
    return {
      accessToken: this.nextAccessToken,
      expiresInSeconds: 3600
    };
  }

  public async revokeToken(): Promise<void> {}
}

function createMockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as typeof fetch;
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

describe("Gmail API client", () => {
  const dummySleep = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    dummySleep.mockClear();
  });

  it("lists messages with query parameters and handles pagination", async () => {
    let capturedUrl = "";
    let capturedAuthHeader: string | null = null;

    const mockFetch = createMockFetch((url, init) => {
      capturedUrl = url;
      capturedAuthHeader = (init?.headers as Headers).get("Authorization");
      return jsonResponse({
        messages: [
          { id: "msg-1", threadId: "thread-1" },
          { id: "msg-2", threadId: "thread-2" }
        ],
        nextPageToken: "next-token-abc",
        resultSizeEstimate: 100
      });
    });

    const client = new GmailClient({
      tokenProvider: createStaticTokenProvider(FAKE_ACCESS_TOKEN),
      fetch: mockFetch,
      sleep: dummySleep
    });

    const result = await client.listMessages({
      maxResults: 50,
      pageToken: "page-1",
      q: "is:unread",
      labelIds: ["INBOX", "IMPORTANT"],
      includeSpamTrash: false
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.id).toBe("msg-1");
    expect(result.nextPageToken).toBe("next-token-abc");
    expect(capturedAuthHeader).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`);
    expect(capturedUrl).toContain("maxResults=50");
    expect(capturedUrl).toContain("pageToken=page-1");
    expect(capturedUrl).toContain("q=is%3Aunread");
    expect(capturedUrl).toContain("labelIds=INBOX");
    expect(capturedUrl).toContain("labelIds=IMPORTANT");
    expect(capturedUrl).toContain("includeSpamTrash=false");
  });

  it("reads the mailbox history cursor and paginated history changes", async () => {
    const capturedUrls: string[] = [];
    const mockFetch = createMockFetch((url) => {
      capturedUrls.push(url);
      if (url.endsWith("/profile")) {
        return jsonResponse({ emailAddress: "owner@gmail.com", historyId: "123456" });
      }
      return jsonResponse({
        historyId: "123789",
        nextPageToken: "history-page-2",
        history: [{
          id: "123700",
          messagesAdded: [{ message: { id: "message-1", threadId: "thread-1" } }],
          labelsAdded: [{ message: { id: "message-2" }, labelIds: ["STARRED"] }]
        }]
      });
    });
    const client = new GmailClient({
      tokenProvider: createStaticTokenProvider(FAKE_ACCESS_TOKEN),
      fetch: mockFetch,
      sleep: dummySleep
    });

    const profile = await client.getProfile();
    const history = await client.listHistory({
      startHistoryId: profile.historyId,
      maxResults: 100,
      pageToken: "history-page-1",
      historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]
    });

    expect(profile.historyId).toBe("123456");
    expect(history.history[0]?.messagesAdded[0]?.message.id).toBe("message-1");
    expect(history.history[0]?.labelsAdded[0]?.labelIds).toEqual(["STARRED"]);
    expect(capturedUrls[0]).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    expect(capturedUrls[1]).toContain("startHistoryId=123456");
    expect(capturedUrls[1]).toContain("pageToken=history-page-1");
    expect(capturedUrls[1]).toContain("historyTypes=messageAdded");
    expect(capturedUrls[1]).toContain("historyTypes=labelRemoved");
  });

  it("fetches message details with headers and payload parts", async () => {
    let capturedUrl = "";
    const mockFetch = createMockFetch((url) => {
      capturedUrl = url;
      return jsonResponse({
        id: "msg-123",
        threadId: "thread-456",
        labelIds: ["INBOX"],
        snippet: "Meeting tomorrow at 10am",
        historyId: "987654",
        internalDate: "1720000000000",
        payload: {
          partId: "",
          mimeType: "text/plain",
          headers: [
            { name: "Subject", "value": "Project Sync" },
            { name: "From", "value": "lead@example.com" }
          ],
          body: { size: 24, data: "VGVzdCBib2R5" }
        }
      });
    });

    const client = new GmailClient({
      tokenProvider: createStaticTokenProvider(FAKE_ACCESS_TOKEN),
      fetch: mockFetch,
      sleep: dummySleep
    });

    const message = await client.getMessage("msg-123", {
      format: "full",
      metadataHeaders: ["Subject", "From"]
    });

    expect(message.id).toBe("msg-123");
    expect(message.threadId).toBe("thread-456");
    expect(message.snippet).toBe("Meeting tomorrow at 10am");
    expect(message.payload?.headers?.[0]?.value).toBe("Project Sync");
    expect(capturedUrl).toContain("/messages/msg-123");
    expect(capturedUrl).toContain("format=full");
    expect(capturedUrl).toContain("metadataHeaders=Subject");
    expect(capturedUrl).toContain("metadataHeaders=From");
  });

  it("fetches a thread with multiple messages", async () => {
    const mockFetch = createMockFetch(() =>
      jsonResponse({
        id: "thread-789",
        historyId: "54321",
        messages: [
          { id: "msg-1", threadId: "thread-789", labelIds: ["INBOX"] },
          { id: "msg-2", threadId: "thread-789", labelIds: ["SENT"] }
        ]
      })
    );

    const client = new GmailClient({
      tokenProvider: createStaticTokenProvider(FAKE_ACCESS_TOKEN),
      fetch: mockFetch,
      sleep: dummySleep
    });

    const thread = await client.getThread("thread-789");
    expect(thread.id).toBe("thread-789");
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[1]?.id).toBe("msg-2");
  });

  it("lists labels and gets specific label metadata", async () => {
    const mockFetch = createMockFetch((url) => {
      if (url.endsWith("/labels")) {
        return jsonResponse({
          labels: [
            { id: "INBOX", name: "INBOX", type: "system" },
            {
              id: "CUSTOM_1",
              name: "Work",
              type: "user",
              color: { backgroundColor: "#4986e7", textColor: "#ffffff" }
            }
          ]
        });
      }
      return jsonResponse({
        id: "INBOX",
        name: "INBOX",
        type: "system",
        messagesTotal: 150,
        messagesUnread: 12,
        threadsTotal: 80,
        threadsUnread: 5
      });
    });

    const client = new GmailClient({
      tokenProvider: createStaticTokenProvider(FAKE_ACCESS_TOKEN),
      fetch: mockFetch,
      sleep: dummySleep
    });

    const labels = await client.listLabels();
    expect(labels).toHaveLength(2);
    expect(labels[0]?.id).toBe("INBOX");
    expect(labels[1]?.name).toBe("Work");
    expect(labels[1]?.color?.backgroundColor).toBe("#4986e7");

    const inbox = await client.getLabel("INBOX");
    expect(inbox.messagesTotal).toBe(150);
    expect(inbox.messagesUnread).toBe(12);
  });

  it("throws GmailNotFoundError for 404 responses without retrying", async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount += 1;
      return jsonResponse({ error: { message: "Not Found", code: 404 } }, 404);
    });

    const client = new GmailClient({
      tokenProvider: createStaticTokenProvider(FAKE_ACCESS_TOKEN),
      fetch: mockFetch,
      sleep: dummySleep,
      maxRetries: 3
    });

    await expect(client.getMessage("missing-id")).rejects.toBeInstanceOf(GmailNotFoundError);
    expect(callCount).toBe(1); // 404 must not be retried
  });

  it("reports malformed successful responses as invalid Gmail data", async () => {
    const client = new GmailClient({
      tokenProvider: createStaticTokenProvider(FAKE_ACCESS_TOKEN),
      fetch: createMockFetch(() => jsonResponse({ id: "msg-1" })),
      sleep: dummySleep
    });

    await expect(client.getMessage("private-message-id")).rejects.toMatchObject({
      code: "INVALID_GMAIL_RESPONSE",
      statusCode: 502,
      details: { endpoint: "/messages/:id" }
    });
  });

  it("rejects an oversized successful Gmail response before JSON parsing", async () => {
    const oversizedBody = JSON.stringify({
      id: "msg-1",
      threadId: "thread-1",
      payload: { mimeType: "text/plain", body: { data: "A".repeat(8 * 1024 * 1024) } }
    });
    const client = new GmailClient({
      tokenProvider: createStaticTokenProvider(FAKE_ACCESS_TOKEN),
      fetch: createMockFetch(() => new Response(oversizedBody, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })),
      sleep: dummySleep,
      maxRetries: 0
    });

    await expect(client.getMessage("oversized-message")).rejects.toMatchObject({
      code: "INVALID_GMAIL_RESPONSE",
      statusCode: 502
    });
  });

  it("bounds error response bodies before checking rate-limit markers", async () => {
    const oversizedBody = JSON.stringify({ error: "x".repeat(70 * 1024), reason: "userRateLimitExceeded" });
    const client = new GmailClient({
      tokenProvider: createStaticTokenProvider(FAKE_ACCESS_TOKEN),
      fetch: createMockFetch(() => new Response(oversizedBody, {
        status: 403,
        headers: { "Content-Type": "application/json" }
      })),
      sleep: dummySleep,
      maxRetries: 0
    });

    await expect(client.listMessages()).rejects.toMatchObject({
      code: "GMAIL_REQUEST_FAILED",
      statusCode: 403
    });
  });

  it("keeps tokens and Gmail search queries out of retry logs", async () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn } as unknown as Logger;
    let callCount = 0;
    const client = new GmailClient({
      tokenProvider: createStaticTokenProvider(FAKE_ACCESS_TOKEN),
      fetch: createMockFetch(() => {
        callCount += 1;
        return callCount === 1
          ? jsonResponse({ error: "Backend server error" }, 500)
          : jsonResponse({ messages: [] });
      }),
      sleep: dummySleep,
      logger
    });

    await client.listMessages({ q: `from:private@example.com ${FAKE_ACCESS_TOKEN}` });

    const logs = JSON.stringify(warn.mock.calls);
    expect(logs).not.toContain(FAKE_ACCESS_TOKEN);
    expect(logs).not.toContain("private@example.com");
    expect(logs).toContain("/messages");
  });

  it("retries transient 500 errors with backoff and succeeds", async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount += 1;
      if (callCount < 3) {
        return jsonResponse({ error: "Backend server error" }, 500);
      }
      return jsonResponse({ id: "msg-1", threadId: "thread-1", labelIds: [] });
    });

    const client = new GmailClient({
      tokenProvider: createStaticTokenProvider(FAKE_ACCESS_TOKEN),
      fetch: mockFetch,
      sleep: dummySleep,
      maxRetries: 3
    });

    const message = await client.getMessage("msg-1");
    expect(message.id).toBe("msg-1");
    expect(callCount).toBe(3);
    expect(dummySleep).toHaveBeenCalledTimes(2);
  });

  it("retries transient network failures and succeeds", async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(async () => {
      callCount += 1;
      if (callCount === 1) throw new TypeError("Connection reset.");
      return jsonResponse({ messages: [] });
    });

    const client = new GmailClient({
      tokenProvider: createStaticTokenProvider(FAKE_ACCESS_TOKEN),
      fetch: mockFetch,
      sleep: dummySleep,
      maxRetries: 2
    });

    await expect(client.listMessages()).resolves.toMatchObject({ messages: [] });
    expect(callCount).toBe(2);
    expect(dummySleep).toHaveBeenCalledTimes(1);
  });

  it("retries rate-limited 429 responses respecting Retry-After header", async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount += 1;
      if (callCount === 1) {
        return jsonResponse({ error: "Too Many Requests" }, 429, { "Retry-After": "2" });
      }
      return jsonResponse({ messages: [], resultSizeEstimate: 0 });
    });

    const client = new GmailClient({
      tokenProvider: createStaticTokenProvider(FAKE_ACCESS_TOKEN),
      fetch: mockFetch,
      sleep: dummySleep,
      maxRetries: 3
    });

    const result = await client.listMessages();
    expect(result.messages).toEqual([]);
    expect(callCount).toBe(2);
    expect(dummySleep).toHaveBeenCalledWith(2000);
  });

  it("retries rate-limited 403 userRateLimitExceeded responses", async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount += 1;
      if (callCount === 1) {
        return jsonResponse({ error: { message: "User Rate Limit Exceeded", reason: "userRateLimitExceeded" } }, 403);
      }
      return jsonResponse({ labels: [] });
    });

    const client = new GmailClient({
      tokenProvider: createStaticTokenProvider(FAKE_ACCESS_TOKEN),
      fetch: mockFetch,
      sleep: dummySleep,
      maxRetries: 3
    });

    const labels = await client.listLabels();
    expect(labels).toEqual([]);
    expect(callCount).toBe(2);
  });

  it("throws GmailRateLimitError when rate limit retries are exhausted", async () => {
    const mockFetch = createMockFetch(() =>
      jsonResponse({ error: "Rate limit exceeded" }, 429)
    );

    const client = new GmailClient({
      tokenProvider: createStaticTokenProvider(FAKE_ACCESS_TOKEN),
      fetch: mockFetch,
      sleep: dummySleep,
      maxRetries: 2
    });

    await expect(client.listMessages()).rejects.toBeInstanceOf(GmailRateLimitError);
    expect(dummySleep).toHaveBeenCalledTimes(2);
  });

  it("recovers from 401 Unauthorized by invalidating token and retrying with fresh token", async () => {
    let callCount = 0;
    const provider: GmailTokenProvider = {
      getAccessToken: vi.fn()
        .mockResolvedValueOnce("expired-access-sentinel")
        .mockResolvedValueOnce("fresh-access-sentinel"),
      invalidateToken: vi.fn()
    };

    const mockFetch = createMockFetch((_url, init) => {
      callCount += 1;
      const auth = (init?.headers as Headers).get("Authorization");
      if (auth === "Bearer expired-access-sentinel") {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
      return jsonResponse({ id: "msg-1", threadId: "t-1", labelIds: [] });
    });

    const client = new GmailClient({
      tokenProvider: provider,
      fetch: mockFetch,
      sleep: dummySleep
    });

    const message = await client.getMessage("msg-1");
    expect(message.id).toBe("msg-1");
    expect(callCount).toBe(2);
    expect(provider.invalidateToken).toHaveBeenCalledTimes(1);
  });

  it("throws GmailReauthRequiredError if 401 Unauthorized persists after refresh", async () => {
    const provider: GmailTokenProvider = {
      getAccessToken: vi.fn().mockResolvedValue("bad-token"),
      invalidateToken: vi.fn()
    };

    const mockFetch = createMockFetch(() => jsonResponse({ error: "Unauthorized" }, 401));

    const client = new GmailClient({
      tokenProvider: provider,
      fetch: mockFetch,
      sleep: dummySleep
    });

    await expect(client.getMessage("msg-1")).rejects.toBeInstanceOf(GmailReauthRequiredError);
    expect(provider.invalidateToken).toHaveBeenCalledTimes(1);
  });

  it("never includes access or refresh tokens in error messages or details", () => {
    const errorWithToken = new GmailApiError(
      500,
      "ERROR",
      `Failed with Bearer ${FAKE_ACCESS_TOKEN} and refresh_token=${FAKE_REFRESH_TOKEN}`,
      false,
      {
        endpoint: "/messages",
        secretToken: FAKE_ACCESS_TOKEN,
        safeField: "safe-value",
        nested: {
          refreshToken: FAKE_REFRESH_TOKEN,
          note: `refresh_token=${FAKE_REFRESH_TOKEN}`
        }
      }
    );

    expect(errorWithToken.message).not.toContain(FAKE_ACCESS_TOKEN);
    expect(errorWithToken.message).not.toContain(FAKE_REFRESH_TOKEN);
    expect(errorWithToken.message).toContain("[REDACTED]");

    expect(errorWithToken.details.secretToken).toBeUndefined();
    expect(errorWithToken.details.safeField).toBe("safe-value");
    expect(errorWithToken.details.nested).toEqual({ note: "refresh_token=[REDACTED]" });
    expect(JSON.stringify(errorWithToken.details)).not.toContain(FAKE_ACCESS_TOKEN);
    expect(JSON.stringify(errorWithToken.details)).not.toContain(FAKE_REFRESH_TOKEN);
  });

  it("refreshing token provider caches tokens and updates store on reauth failure", async () => {
    const store = new MemoryConnectionStore();
    const oauth = new FakeOAuthClient();

    let currentTime = 1000;
    const provider = createRefreshingTokenProvider({
      userId: "user-1",
      connectionStore: store,
      oauthClient: oauth,
      clock: () => currentTime,
      bufferMs: 60_000
    });

    // First call refreshes token
    const token1 = await provider.getAccessToken();
    expect(token1).toBe("refreshed-access-sentinel");
    expect(oauth.refreshCount).toBe(1);

    // Call before expiry uses in-memory cache
    currentTime += 100_000;
    const token2 = await provider.getAccessToken();
    expect(token2).toBe("refreshed-access-sentinel");
    expect(oauth.refreshCount).toBe(1); // No new network call

    // Simulating token revocation on next refresh
    currentTime += 4_000_000; // Past expiry
    oauth.shouldFailWithReauth = true;

    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(GmailReauthRequiredError);
    expect(store.status).toBe("reauth_required");
  });
});
