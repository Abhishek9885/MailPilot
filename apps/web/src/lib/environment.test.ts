import { describe, expect, it } from "vitest";
import { WebEnvironmentSchema } from "@mailpilot/shared";

describe("web environment schema", () => {
  it("accepts a local API URL and supplies its safe development default", () => {
    expect(WebEnvironmentSchema.parse({}).apiBaseUrl).toBe("http://localhost:4000");
  });

  it("rejects malformed API URLs", () => {
    expect(() => WebEnvironmentSchema.parse({ NEXT_PUBLIC_API_BASE_URL: "not-a-url" })).toThrow();
  });
});
