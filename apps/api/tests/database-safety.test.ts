import { describe, expect, it } from "vitest";
import { assertSafeDevelopmentSeedTarget, assertSafeIntegrationTestTarget } from "../src/database-safety.js";

const localDevelopmentUrl = "postgresql://mailpilot:local_dev_only@localhost:55432/mailpilot?schema=public";
const localTestUrl = "postgresql://mailpilot:local_dev_only@localhost:55432/mailpilot_test?schema=public";

describe("database target safety", () => {
  it("allows a seed only for the expected local development database", () => {
    expect(() => assertSafeDevelopmentSeedTarget(localDevelopmentUrl, "development")).not.toThrow();
  });

  it.each([
    [localDevelopmentUrl, "production"],
    ["postgresql://user:password@db.example.com:55432/mailpilot?schema=public", "development"],
    ["postgresql://mailpilot:local_dev_only@localhost:5432/mailpilot?schema=public", "development"],
    [localTestUrl, "development"]
  ])("refuses unsafe seed target %s", (databaseUrl, nodeEnvironment) => {
    expect(() => assertSafeDevelopmentSeedTarget(databaseUrl, nodeEnvironment)).toThrow(/local mailpilot database/);
  });

  it("allows integration tests only against the named loopback test database", () => {
    expect(() => assertSafeIntegrationTestTarget(localTestUrl)).not.toThrow();
    expect(() => assertSafeIntegrationTestTarget(localDevelopmentUrl)).toThrow(/mailpilot_test/);
  });

  it("does not include a rejected connection string in errors", () => {
    const sensitiveUrl = "postgresql://user:secret-value@db.example.com:5432/live";

    try {
      assertSafeIntegrationTestTarget(sensitiveUrl);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) expect(error.message).not.toContain("secret-value");
    }
  });
});
