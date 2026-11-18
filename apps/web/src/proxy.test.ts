import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

describe("web authentication proxy", () => {
  it.each(["/", "/inbox", "/drafts", "/approvals", "/tasks", "/archive", "/agent", "/activity", "/settings"])(
    "redirects protected page %s without a session cookie to sign-in",
    (path) => {
      const response = proxy(new NextRequest(`http://localhost:3000${path}`));
      const location = new URL(response.headers.get("location") ?? "http://localhost:3000");

      expect(response.status).toBe(307);
      expect(location.pathname).toBe("/sign-in");
      expect(location.searchParams.get("returnTo")).toBe(path);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  );

  it("lets the server session check decide when a cookie exists", () => {
    const request = new NextRequest("http://localhost:3000/inbox", {
      headers: { cookie: "mailpilot_session=expired-or-valid" }
    });
    const response = proxy(request);

    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("leaves sign-in and public health pages available without a session", () => {
    const signInResponse = proxy(new NextRequest("http://localhost:3000/sign-in"));
    const healthResponse = proxy(new NextRequest("http://localhost:3000/api/health"));

    expect(signInResponse.headers.get("location")).toBeNull();
    expect(healthResponse.headers.get("location")).toBeNull();
  });
});
