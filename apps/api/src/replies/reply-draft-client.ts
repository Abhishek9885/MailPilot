import { createHmac, randomUUID } from "node:crypto";
import {
  ReplyDraftServiceResponseSchema,
  type ReplyDraftServiceRequest,
  type ReplyDraftServiceResponse
} from "@mailpilot/shared";
import { ApiError } from "../errors.js";

export interface ReplyDraftClient {
  draft(input: ReplyDraftServiceRequest): Promise<ReplyDraftServiceResponse>;
}

export class FastApiReplyDraftClient implements ReplyDraftClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
    private readonly timeoutMs: number,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  public async draft(input: ReplyDraftServiceRequest): Promise<ReplyDraftServiceResponse> {
    const path = "/internal/v1/reply-drafts/";
    const serviceRequestId = randomUUID();
    const serviceTimestamp = Math.floor(Date.now() / 1_000).toString();
    const requestBody = JSON.stringify(input);
    const signatureContent = [serviceTimestamp, "POST", path, serviceRequestId, requestBody].join("\n");
    const signature = createHmac("sha256", this.serviceToken)
      .update(signatureContent, "utf8")
      .digest("hex");
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.baseUrl), {
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
      throw new ApiError(503, "AI_SERVICE_UNAVAILABLE", "Reply drafting is temporarily unavailable", true);
    }

    if (!response.ok) {
      await response.body?.cancel();
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterValue = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
      const retryAfterSeconds = Number.isFinite(retryAfterValue) && retryAfterValue >= 0
        ? Math.ceil(retryAfterValue)
        : undefined;
      const statusCode = response.status === 413 ? 413 : response.status === 429 ? 429 : 502;
      throw new ApiError(
        statusCode,
        response.status === 413 ? "REPLY_DRAFT_INPUT_TOO_LARGE" : "REPLY_DRAFT_FAILED",
        response.status === 413
          ? "The thread exceeds the reply drafting size limit"
          : "Reply drafting could not be completed",
        response.status === 429 || response.status >= 500,
        retryAfterSeconds
      );
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      throw new ApiError(502, "AI_RESPONSE_INVALID", "Reply drafting returned an invalid response");
    }
    const parsed = ReplyDraftServiceResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new ApiError(502, "AI_RESPONSE_INVALID", "Reply drafting returned an invalid response");
    }
    return parsed.data;
  }
}
