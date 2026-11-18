export interface GmailErrorDetails {
  endpoint?: string | undefined;
  method?: string | undefined;
  googleErrorCode?: number | undefined;
  googleErrorStatus?: string | undefined;
  reason?: string | undefined;
  retryAfterMs?: number | undefined;
  attempt?: number | undefined;
  [key: string]: unknown;
}

export class GmailApiError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly details: GmailErrorDetails = {}
  ) {
    super(sanitizeMessage(message));
    this.name = "GmailApiError";
    // Ensure any credentials are removed from details
    this.details = sanitizeDetails(details);
  }
}

export class GmailRateLimitError extends GmailApiError {
  public constructor(message = "Gmail rate limit exceeded.", retryAfterMs?: number, details: GmailErrorDetails = {}) {
    super(429, "RATE_LIMITED", message, true, { ...details, retryAfterMs });
    this.name = "GmailRateLimitError";
  }
}

export class GmailReauthRequiredError extends GmailApiError {
  public constructor(message = "Gmail reauthorization is required.", details: GmailErrorDetails = {}) {
    super(401, "REAUTH_REQUIRED", message, false, details);
    this.name = "GmailReauthRequiredError";
  }
}

export class GmailNotFoundError extends GmailApiError {
  public constructor(message = "Requested Gmail resource was not found.", details: GmailErrorDetails = {}) {
    super(404, "NOT_FOUND", message, false, details);
    this.name = "GmailNotFoundError";
  }
}

export function isTransientGmailStatus(statusCode: number): boolean {
  return statusCode === 429 || statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504;
}

export function isTransientGmailError(error: unknown): boolean {
  if (error instanceof GmailRateLimitError) return true;
  if (error instanceof GmailApiError) return error.retryable;

  if (typeof error === "object" && error !== null) {
    // Network failures / fetch timeouts
    if ("name" in error && (error.name === "TypeError" || error.name === "AbortError" || error.name === "FetchError")) {
      return true;
    }
    if ("code" in error) {
      const code = String(error.code);
      if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN" || code === "UND_ERR_CONNECT_TIMEOUT") {
        return true;
      }
    }
  }

  return false;
}

function sanitizeMessage(message: string): string {
  // Error messages can be serialized or logged by callers, so redact credentials here too.
  return message
    .replace(/\b(Bearer\s+)[^\s"'&,}]+/gi, "$1[REDACTED]")
    .replace(/((?:access_token|refresh_token)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, "$1[REDACTED]");
}

function sanitizeDetails(details: GmailErrorDetails): GmailErrorDetails {
  return sanitizeDetailValue(details) as GmailErrorDetails;
}

function sanitizeDetailValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeMessage(value);
  if (Array.isArray(value)) return value.map(sanitizeDetailValue);
  if (typeof value !== "object" || value === null) return value;

  const clean: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes("token") ||
      lowerKey.includes("secret") ||
      lowerKey.includes("auth") ||
      lowerKey.includes("password") ||
      lowerKey.includes("cookie")
    ) {
      continue;
    }
    clean[key] = sanitizeDetailValue(nestedValue);
  }
  return clean;
}

