import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("web liveness endpoint", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns a content-free health response with a correlated request ID", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const requestId = "d24cb56a-b2f9-4b32-a74a-a36da9fd9300";
    const response = GET(new Request("http://localhost/api/health", {
      headers: { "x-request-id": requestId }
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ service: "web", status: "ok", requestId });
  });

  it("replaces invalid request IDs with generated IDs", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = GET(new Request("http://localhost/api/health", {
      headers: { "x-request-id": "not-a-uuid" }
    }));
    const requestId = response.headers.get("x-request-id");

    expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await response.json()).toMatchObject({ service: "web", status: "ok", requestId });
  });
});
