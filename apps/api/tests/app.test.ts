import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import pino from "pino";
import { createApp } from "../src/app.js";

describe("API health and errors", () => {
  it("returns a request ID from the liveness endpoint", async () => {
    const app = createApp({ checkDatabase: async () => undefined, logger: pino({ level: "silent" }) });
    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ service: "api", status: "ok" });
    expect(response.body.requestId).toBe(response.headers["x-request-id"]);
  });

  it("preserves a valid request ID for cross-service correlation", async () => {
    const requestId = "d24cb56a-b2f9-4b32-a74a-a36da9fd9300";
    const app = createApp({ checkDatabase: async () => undefined, logger: pino({ level: "silent" }) });
    const response = await request(app).get("/health/live").set("x-request-id", requestId);

    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.body.requestId).toBe(requestId);
  });

  it("reports readiness only when the database responds", async () => {
    const checkDatabase = vi.fn().mockRejectedValue(new Error("database credentials must not leak"));
    const app = createApp({ checkDatabase, logger: pino({ level: "silent" }) });
    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ service: "api", status: "unavailable" });
    expect(JSON.stringify(response.body)).not.toContain("credentials");
  });

  it("returns the standard JSON envelope for missing routes", async () => {
    const app = createApp({ checkDatabase: async () => undefined, logger: pino({ level: "silent" }) });
    const response = await request(app).get("/missing");

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: "NOT_FOUND", retryable: false });
    expect(response.body.error.requestId).toBe(response.headers["x-request-id"]);
  });

  it("returns a safe client error for malformed JSON", async () => {
    const app = createApp({ checkDatabase: async () => undefined, logger: pino({ level: "silent" }) });
    const response = await request(app)
      .post("/v1/example")
      .set("content-type", "application/json")
      .send("{bad json");

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "Request body must be valid JSON",
      retryable: false
    });
    expect(response.body.error.requestId).toBe(response.headers["x-request-id"]);
    expect(JSON.stringify(response.body)).not.toContain("bad json");
  });
});
