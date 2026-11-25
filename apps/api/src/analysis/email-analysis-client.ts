import { createHmac, randomUUID } from "node:crypto";
import {
  EmailAnalysisServiceResponseSchema,
  ServiceErrorSchema,
  type EmailAnalysisServiceResponse
} from "@mailpilot/shared";
import { ApiError } from "../errors.js";

export interface AnalyzeEmailInput {
  userId: string;
  emailId: string;
  sourceRevision: number;
  subject: string;
  senderName: string | null;
  senderEmail: string | null;
  receivedAt: Date;
  bodyText: string;
}

export interface EmailAnalysisClient {
  analyze(input: AnalyzeEmailInput, requestId?: string): Promise<EmailAnalysisServiceResponse>;
}

export class FastApiEmailAnalysisClient implements EmailAnalysisClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
    private readonly timeoutMs: number,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  public async analyze(input: AnalyzeEmailInput, requestId?: string): Promise<EmailAnalysisServiceResponse> {
    let response: Response;
    const serviceRequestId = requestId ?? randomUUID();
    const serviceTimestamp = Math.floor(Date.now() / 1_000).toString();
    const requestBody = JSON.stringify({
      userId: input.userId,
      emailId: input.emailId,
      sourceRevision: input.sourceRevision,
      subject: input.subject,
      senderName: input.senderName,
      senderEmail: input.senderEmail,
      receivedAt: input.receivedAt.toISOString(),
      bodyText: input.bodyText
    });
    const signatureContent = [
      serviceTimestamp,
      "POST",
      "/internal/v1/email-analysis/",
      serviceRequestId,
      requestBody
    ].join("\n");
    const signature = createHmac("sha256", this.serviceToken)
      .update(signatureContent, "utf8")
      .digest("hex");
    try {
      response = await this.fetcher(new URL("/internal/v1/email-analysis/", this.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": serviceRequestId,
          "x-service-timestamp": serviceTimestamp,
          "x-service-signature": signature
        },
        body: requestBody,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new ApiError(
        503,
        "AI_SERVICE_UNAVAILABLE",
        "Email analysis is temporarily unavailable",
        true
      );
    }

    if (!response.ok) {
      let downstreamErrorCode: string | undefined;
      if ([401, 429, 502, 503, 504].includes(response.status)) {
        try {
          const parsedError = ServiceErrorSchema.safeParse(await response.json());
          if (parsedError.success) downstreamErrorCode = parsedError.data.error.code;
        } catch {
          // The public API returns a safe fallback for an unexpected AI error body.
        }
      } else {
        await response.body?.cancel();
      }

      const isConfigurationError =
        (response.status === 503 && ["INTERNAL", "LLM_CONFIGURATION_INVALID"].includes(downstreamErrorCode ?? ""))
        || (response.status === 401 && downstreamErrorCode === "UNAUTHENTICATED");
      if (isConfigurationError) {
        throw new ApiError(
          503,
          "AI_CONFIGURATION_REQUIRED",
          "Email analysis needs AI setup. Set OPENAI_API_KEY and a shared AI_SERVICE_TOKEN in the repository .env file, then restart the API and AI service."
        );
      }

      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterValue = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
      const retryAfterSeconds = Number.isFinite(retryAfterValue) && retryAfterValue >= 0
        ? Math.ceil(retryAfterValue)
        : undefined;
      if (downstreamErrorCode === "LLM_AUTHENTICATION_FAILED") {
        throw new ApiError(
          502,
          "AI_PROVIDER_AUTHENTICATION_FAILED",
          "OpenAI rejected the API key. Check that OPENAI_API_KEY is an active key from the intended API project."
        );
      }
      if (downstreamErrorCode === "LLM_REQUEST_REJECTED") {
        throw new ApiError(
          502,
          "AI_PROVIDER_REQUEST_REJECTED",
          "OpenAI rejected the configured model or request. Check AI_LLM_MODEL and model access for this API project."
        );
      }
      if (downstreamErrorCode === "LLM_RATE_LIMITED") {
        throw new ApiError(
          429,
          "AI_PROVIDER_RATE_LIMITED",
          "OpenAI limited this request. Check API project usage, limits, and billing before retrying.",
          true,
          retryAfterSeconds
        );
      }
      if (downstreamErrorCode === "LLM_TIMEOUT") {
        throw new ApiError(504, "AI_PROVIDER_TIMEOUT", "OpenAI did not respond in time. Try again later.", true);
      }
      if (downstreamErrorCode === "LLM_PROVIDER_UNAVAILABLE") {
        throw new ApiError(503, "AI_PROVIDER_UNAVAILABLE", "OpenAI is temporarily unavailable. Try again later.", true);
      }
      const isInputTooLarge = response.status === 413;
      throw new ApiError(
        isInputTooLarge ? 413 : response.status === 429 ? 429 : 502,
        isInputTooLarge ? "EMAIL_TOO_LARGE_TO_ANALYZE" : "AI_ANALYSIS_FAILED",
        isInputTooLarge ? "Email exceeds the analysis size limit" : "Email analysis could not be completed",
        response.status === 429 || response.status >= 500,
        retryAfterSeconds
      );
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      throw new ApiError(502, "AI_RESPONSE_INVALID", "Email analysis returned an invalid response");
    }
    const parsed = EmailAnalysisServiceResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new ApiError(502, "AI_RESPONSE_INVALID", "Email analysis returned an invalid response");
    }
    return parsed.data;
  }
}
