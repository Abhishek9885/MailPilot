import { describe, expect, it } from "vitest";
import { GmailConnectionResponseSchema, ServiceErrorSchema, ServiceHealthSchema } from "../src/index.js";

describe("shared runtime contracts", () => {
  it("accepts a valid service health response", () => {
    expect(ServiceHealthSchema.parse({
      service: "api",
      status: "ok",
      requestId: "00000000-0000-4000-8000-000000000001"
    }).status).toBe("ok");
  });

  it("rejects error responses without request IDs", () => {
    expect(ServiceErrorSchema.safeParse({
      error: { code: "INTERNAL", message: "Failed", retryable: false, details: {} }
    }).success).toBe(false);
  });

  it("validates Gmail connection details and nullable states", () => {
    const withConnection = GmailConnectionResponseSchema.parse({
      connection: {
        email: "user@gmail.com",
        status: "active",
        grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        connectedAt: "2026-10-28T12:00:00.000Z",
        disconnectedAt: null,
        lastSuccessfulSyncAt: null,
        reauthRequired: false
      }
    });
    expect(withConnection.connection?.email).toBe("user@gmail.com");

    const withoutConnection = GmailConnectionResponseSchema.parse({
      connection: null
    });
    expect(withoutConnection.connection).toBeNull();
  });
});
