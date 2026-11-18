import { describe, expect, it } from "vitest";
import { loadApiEnvironment } from "../src/environment.js";

describe("API environment", () => {
  it("loads defaults and validated local configuration", () => {
    const environment = loadApiEnvironment({
      DATABASE_URL: "postgresql://mailpilot:local_dev_only@localhost:55432/mailpilot?schema=public"
    });

    expect(environment).toMatchObject({
      NODE_ENV: "development",
      API_PORT: 4000,
      API_LOG_LEVEL: "info",
      WEB_ORIGIN: "http://localhost:3000"
    });
  });

  it("reports invalid variable names without exposing supplied values", () => {
    const secretValue = "not-a-database-url-with-sensitive-value";

    expect(() => loadApiEnvironment({ DATABASE_URL: secretValue })).toThrow(/DATABASE_URL/);
    try {
      loadApiEnvironment({ DATABASE_URL: secretValue });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).not.toContain(secretValue);
      }
    }
  });

  it("requires configured same-host HTTPS origins and real auth secrets in production", () => {
    const secretValue = "production-only-test-session-secret-value";

    expect(() => loadApiEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://mailpilot:local_dev_only@localhost:55432/mailpilot?schema=public",
      WEB_ORIGIN: "https://mailpilot.example",
      API_PUBLIC_ORIGIN: "https://api.mailpilot.example",
      GOOGLE_OIDC_CLIENT_ID: "production-client-id",
      GOOGLE_OIDC_CLIENT_SECRET: "production-client-secret",
      SESSION_SECRET: secretValue
    })).toThrow(/API_PUBLIC_ORIGIN/);

    try {
      loadApiEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://mailpilot:local_dev_only@localhost:55432/mailpilot?schema=public",
        WEB_ORIGIN: "https://mailpilot.example",
        API_PUBLIC_ORIGIN: "https://api.mailpilot.example",
        GOOGLE_OIDC_CLIENT_ID: "production-client-id",
        GOOGLE_OIDC_CLIENT_SECRET: "production-client-secret",
        SESSION_SECRET: secretValue
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) expect(error.message).not.toContain(secretValue);
    }
  });
});
