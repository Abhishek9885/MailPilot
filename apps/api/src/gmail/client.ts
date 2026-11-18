import type { Logger } from "pino";
import {
  GmailApiError,
  GmailNotFoundError,
  GmailRateLimitError,
  GmailReauthRequiredError,
  isTransientGmailError,
  isTransientGmailStatus
} from "./api-errors.js";
import {
  type GetMessageOptions,
  type GetThreadOptions,
  type GmailLabel,
  GmailLabelSchema,
  type GmailProfile,
  GmailProfileSchema,
  type ListHistoryOptions,
  type ListHistoryResponse,
  ListHistoryResponseSchema,
  type GmailMessage,
  GmailMessageSchema,
  type GmailThread,
  GmailThreadSchema,
  type ListMessagesOptions,
  type ListMessagesResponse,
  ListMessagesResponseSchema,
  ListLabelsResponseSchema
} from "./api-types.js";
import type { GmailTokenProvider } from "./token-provider.js";

const DEFAULT_GMAIL_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailClientOptions {
  tokenProvider: GmailTokenProvider;
  baseUrl?: string | undefined;
  maxRetries?: number | undefined;
  initialDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  backoffMultiplier?: number | undefined;
  fetch?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  logger?: Logger | undefined;
}

export class GmailClient {
  private readonly tokenProvider: GmailTokenProvider;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly backoffMultiplier: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly logger?: Logger | undefined;

  public constructor(options: GmailClientOptions) {
    this.tokenProvider = options.tokenProvider;
    this.baseUrl = (options.baseUrl ?? DEFAULT_GMAIL_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? 3;
    this.initialDelayMs = options.initialDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 10_000;
    this.backoffMultiplier = options.backoffMultiplier ?? 2;
    this.fetchFn = options.fetch ?? fetch;
    this.sleepFn = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger;
  }

  public async listMessages(options: ListMessagesOptions = {}): Promise<ListMessagesResponse> {
    const searchParams = new URLSearchParams();
    if (options.maxResults !== undefined) {
      const clamped = Math.max(1, Math.min(500, Math.floor(options.maxResults)));
      searchParams.set("maxResults", String(clamped));
    }
    if (options.pageToken) searchParams.set("pageToken", options.pageToken);
    if (options.q) searchParams.set("q", options.q);
    if (options.includeSpamTrash !== undefined) {
      searchParams.set("includeSpamTrash", String(options.includeSpamTrash));
    }
    if (options.labelIds && options.labelIds.length > 0) {
      for (const labelId of options.labelIds) {
        searchParams.append("labelIds", labelId);
      }
    }

    const query = searchParams.toString();
    const endpoint = `/messages${query ? `?${query}` : ""}`;

    return this.request(endpoint, { method: "GET" }, (data) => ListMessagesResponseSchema.parse(data));
  }

  public async getMessage(messageId: string, options: GetMessageOptions = {}): Promise<GmailMessage> {
    if (!messageId || !messageId.trim()) {
      throw new GmailApiError(400, "INVALID_ARGUMENT", "Message ID must be a non-empty string.");
    }

    const searchParams = new URLSearchParams();
    if (options.format) searchParams.set("format", options.format);
    if (options.metadataHeaders && options.metadataHeaders.length > 0) {
      for (const header of options.metadataHeaders) {
        searchParams.append("metadataHeaders", header);
      }
    }

    const query = searchParams.toString();
    const endpoint = `/messages/${encodeURIComponent(messageId)}${query ? `?${query}` : ""}`;

    return this.request(endpoint, { method: "GET" }, (data) => GmailMessageSchema.parse(data));
  }

  public async getThread(threadId: string, options: GetThreadOptions = {}): Promise<GmailThread> {
    if (!threadId || !threadId.trim()) {
      throw new GmailApiError(400, "INVALID_ARGUMENT", "Thread ID must be a non-empty string.");
    }

    const searchParams = new URLSearchParams();
    if (options.format) searchParams.set("format", options.format);
    if (options.metadataHeaders && options.metadataHeaders.length > 0) {
      for (const header of options.metadataHeaders) {
        searchParams.append("metadataHeaders", header);
      }
    }

    const query = searchParams.toString();
    const endpoint = `/threads/${encodeURIComponent(threadId)}${query ? `?${query}` : ""}`;

    return this.request(endpoint, { method: "GET" }, (data) => GmailThreadSchema.parse(data));
  }

  public async listLabels(): Promise<GmailLabel[]> {
    return this.request("/labels", { method: "GET" }, (data) => {
      const parsed = ListLabelsResponseSchema.parse(data);
      return parsed.labels;
    });
  }

  public async getLabel(labelId: string): Promise<GmailLabel> {
    if (!labelId || !labelId.trim()) {
      throw new GmailApiError(400, "INVALID_ARGUMENT", "Label ID must be a non-empty string.");
    }
    const endpoint = `/labels/${encodeURIComponent(labelId)}`;
    return this.request(endpoint, { method: "GET" }, (data) => GmailLabelSchema.parse(data));
  }

  public async getProfile(): Promise<GmailProfile> {
    return this.request("/profile", { method: "GET" }, (data) => GmailProfileSchema.parse(data));
  }

  public async listHistory(options: ListHistoryOptions): Promise<ListHistoryResponse> {
    if (!options.startHistoryId.trim()) {
      throw new GmailApiError(400, "INVALID_ARGUMENT", "A Gmail history cursor is required.");
    }

    const searchParams = new URLSearchParams({ startHistoryId: options.startHistoryId });
    if (options.maxResults !== undefined) {
      const clamped = Math.max(1, Math.min(500, Math.floor(options.maxResults)));
      searchParams.set("maxResults", String(clamped));
    }
    if (options.pageToken) searchParams.set("pageToken", options.pageToken);
    for (const historyType of options.historyTypes ?? []) {
      searchParams.append("historyTypes", historyType);
    }

    return this.request(`/history?${searchParams.toString()}`, { method: "GET" }, (data) =>
      ListHistoryResponseSchema.parse(data)
    );
  }

  private async request<T>(
    endpoint: string,
    init: RequestInit,
    parser: (data: unknown) => T
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const safeEndpoint = normalizeEndpointForDiagnostics(endpoint);
    let hasRefreshedAuth = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let accessToken: string;
      try {
        accessToken = await this.tokenProvider.getAccessToken();
      } catch (error: unknown) {
        this.logger?.warn(
          { endpoint: safeEndpoint, errorType: error instanceof Error ? error.name : "UnknownError" },
          "gmail.token_acquisition_failed"
        );
        throw error;
      }

      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${accessToken}`);
      headers.set("Accept", "application/json");

      try {
        const response = await this.fetchFn(url, { ...init, headers });

        if (response.ok) {
          let body: unknown;
          try {
            body = await response.json();
          } catch (error: unknown) {
            if (isTransientGmailError(error)) throw error;
            throw invalidGmailResponseError(safeEndpoint, init.method ?? "GET");
          }
          try {
            return parser(body);
          } catch {
            throw invalidGmailResponseError(safeEndpoint, init.method ?? "GET");
          }
        }

        // 401 Unauthorized -> try invalidating the token once
        if (response.status === 401) {
          if (!hasRefreshedAuth) {
            hasRefreshedAuth = true;
            this.tokenProvider.invalidateToken();
            this.logger?.info({ endpoint: safeEndpoint, attempt }, "gmail.auth_refreshed_on_401");
            continue;
          }
          throw new GmailReauthRequiredError("Gmail authorization expired or was revoked.", {
            endpoint: safeEndpoint,
            method: init.method ?? "GET"
          });
        }

        // 404 Not Found
        if (response.status === 404) {
          throw new GmailNotFoundError("Requested Gmail resource was not found.", {
            endpoint: safeEndpoint,
            method: init.method ?? "GET"
          });
        }

        // Check if rate limited
        const is429 = response.status === 429;
        const responseText = await response.text().catch(() => "");
        const isRateLimit403 = response.status === 403 && (
          responseText.includes("rateLimitExceeded") ||
          responseText.includes("userRateLimitExceeded")
        );

        if (is429 || isRateLimit403) {
          const retryAfterHeader = response.headers.get("Retry-After");
          const retryAfterMs = parseRetryAfterHeader(retryAfterHeader);
          const delayMs = retryAfterMs ?? this.calculateBackoff(attempt);

          if (attempt < this.maxRetries) {
            this.logger?.warn({ endpoint: safeEndpoint, attempt, delayMs }, "gmail.rate_limited_retry");
            await this.sleepFn(delayMs);
            continue;
          }

          throw new GmailRateLimitError("Gmail rate limit exceeded.", delayMs, {
            endpoint: safeEndpoint,
            method: init.method ?? "GET",
            googleErrorCode: response.status
          });
        }

        // 5xx Transient server error
        if (isTransientGmailStatus(response.status)) {
          if (attempt < this.maxRetries) {
            const delayMs = this.calculateBackoff(attempt);
            this.logger?.warn(
              { endpoint: safeEndpoint, attempt, status: response.status, delayMs },
              "gmail.transient_error_retry"
            );
            await this.sleepFn(delayMs);
            continue;
          }
          throw new GmailApiError(
            response.status,
            "GMAIL_SERVER_ERROR",
            `Gmail server returned transient error (${response.status}).`,
            true,
            { endpoint: safeEndpoint, method: init.method ?? "GET", googleErrorCode: response.status }
          );
        }

        // Non-transient client/server error
        throw new GmailApiError(
          response.status,
          "GMAIL_REQUEST_FAILED",
          `Gmail request failed with status ${response.status}.`,
          false,
          { endpoint: safeEndpoint, method: init.method ?? "GET", googleErrorCode: response.status }
        );
      } catch (error: unknown) {
        if (error instanceof GmailApiError) {
          throw error;
        }

        // Network or fetch exceptions
        if (isTransientGmailError(error) && attempt < this.maxRetries) {
          const delayMs = this.calculateBackoff(attempt);
          this.logger?.warn(
            {
              endpoint: safeEndpoint,
              attempt,
              delayMs,
              errorType: error instanceof Error ? error.name : "NetworkError"
            },
            "gmail.network_error_retry"
          );
          await this.sleepFn(delayMs);
          continue;
        }

        throw new GmailApiError(
          500,
          "GMAIL_NETWORK_ERROR",
          "Failed to reach Gmail service.",
          true,
          { endpoint: safeEndpoint, method: init.method ?? "GET" }
        );
      }
    }

    throw new GmailApiError(500, "GMAIL_RETRIES_EXHAUSTED", "Exhausted all retries for Gmail request.", false, {
      endpoint: safeEndpoint
    });
  }

  private calculateBackoff(attempt: number): number {
    const exponential = this.initialDelayMs * Math.pow(this.backoffMultiplier, attempt);
    const jitter = Math.random() * 50;
    return Math.min(this.maxDelayMs, Math.round(exponential + jitter));
  }
}

function normalizeEndpointForDiagnostics(endpoint: string): string {
  const path = endpoint.split("?", 1)[0] ?? endpoint;
  return path.replace(/^(\/messages|\/threads|\/labels)\/[^/]+$/, "$1/:id");
}

function invalidGmailResponseError(endpoint: string, method: string): GmailApiError {
  return new GmailApiError(
    502,
    "INVALID_GMAIL_RESPONSE",
    "Gmail returned an invalid response.",
    false,
    { endpoint, method }
  );
}

function parseRetryAfterHeader(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : 0;
  }
  return undefined;
}

