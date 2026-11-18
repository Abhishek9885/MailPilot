import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FastApiEmailAnalysisClient } from "../src/analysis/email-analysis-client.js";

describe("FastAPI email analysis client", () => {
  it("signs the exact internal request body and validates the typed response", async () => {
    const serviceToken = "test-only-shared-hmac-key-that-is-over-32-characters";
    let capturedUrl: URL | undefined;
    let capturedInit: RequestInit | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      capturedUrl = new URL(input.toString());
      capturedInit = init;
      return new Response(JSON.stringify({
        userId: "b9bb0f7d-888f-42db-a58b-4f603426878e",
        emailId: "2992e328-f4fc-4e2c-a05c-5ddb2ce3a065",
        sourceRevision: 2,
        schemaVersion: "email-analysis-v1",
        provider: "openai",
        modelVersion: "gpt-6.1-sol-test",
        responseId: null,
        providerRequestId: null,
        usage: null,
        analysis: {
          categories: ["work"],
          priority: "normal",
          summary: "The sender shared a schedule update.",
          actionItems: [],
          deadlines: [],
          commitments: [],
          eventCandidates: []
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new FastApiEmailAnalysisClient(
      "https://ai.mailpilot.example",
      serviceToken,
      5_000,
      fetcher
    );
    const userId = "b9bb0f7d-888f-42db-a58b-4f603426878e";
    const emailId = "2992e328-f4fc-4e2c-a05c-5ddb2ce3a065";
    const result = await client.analyze({
      userId,
      emailId,
      sourceRevision: 2,
      subject: "Schedule",
      senderName: null,
      senderEmail: "sender@example.test",
      receivedAt: new Date("2026-10-28T12:00:00.000Z"),
      bodyText: "The new schedule is attached."
    });

    expect(capturedUrl?.pathname).toBe("/internal/v1/email-analysis/");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(capturedInit?.body).toBeTypeOf("string");
    const body = capturedInit?.body as string;
    const headers = new Headers(capturedInit?.headers);
    const requestId = headers.get("x-request-id");
    const timestamp = headers.get("x-service-timestamp");
    const signature = headers.get("x-service-signature");
    expect(requestId).toBeTruthy();
    expect(timestamp).toBeTruthy();
    expect(signature).toBeTruthy();
    expect(headers.has("authorization")).toBe(false);
    expect(body).toContain("The new schedule is attached.");
    const signedContent = [
      timestamp,
      "POST",
      "/internal/v1/email-analysis/",
      requestId,
      body
    ].join("\n");
    expect(signature).toBe(createHmac("sha256", serviceToken).update(signedContent).digest("hex"));
    expect(result.modelVersion).toBe("gpt-6.1-sol-test");
    expect(result.analysis.categories).toEqual(["work"]);
  });
});
