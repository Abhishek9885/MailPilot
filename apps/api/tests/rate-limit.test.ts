import { describe, expect, it } from "vitest";
import pino from "pino";
import request from "supertest";
import { createApp } from "../src/app.js";
import type { RateLimitIncrement, RateLimitStore } from "../src/security/rate-limit.js";

class MemoryRateLimitStore implements RateLimitStore {
  public readonly counts = new Map<string, number>();

  public async increment(key: string, ttlMs: number): Promise<RateLimitIncrement> {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return { count, ttlMs };
  }
}

describe("API request rate limiter", () => {
  it("limits repeated OAuth starts and returns a retry hint", async () => {
    const store = new MemoryRateLimitStore();
    const app = createApp({
      checkDatabase: async () => undefined,
      rateLimitStore: store,
      logger: pino({ level: "silent" })
    });

    let lastResponse = await request(app).get("/v1/auth/google/start");
    for (let attempt = 1; attempt < 21; attempt += 1) {
      lastResponse = await request(app).get("/v1/auth/google/start");
    }

    expect(lastResponse.status).toBe(429);
    expect(lastResponse.body.error).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true
    });
    expect(Number(lastResponse.headers["retry-after"])).toBeGreaterThan(0);
    expect([...store.counts.keys()].every((key) => !key.includes("127.0.0.1"))).toBe(true);
  });

  it("fails closed if Redis rate-limit storage is unavailable and leaves health probes unthrottled", async () => {
    const unavailableStore: RateLimitStore = {
      async increment() {
        throw new Error("private Redis connection detail");
      }
    };
    const app = createApp({
      checkDatabase: async () => undefined,
      rateLimitStore: unavailableStore,
      logger: pino({ level: "silent" })
    });

    const health = await request(app).get("/health/live");
    const blockedApiRequest = await request(app).get("/v1/auth/google/start");

    expect(health.status).toBe(200);
    expect(blockedApiRequest.status).toBe(503);
    expect(blockedApiRequest.body.error).toMatchObject({
      code: "RATE_LIMITER_UNAVAILABLE",
      retryable: true
    });
    expect(JSON.stringify(blockedApiRequest.body)).not.toContain("Redis");
  });
});
