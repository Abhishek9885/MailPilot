import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

const PROTECTED_PATHS = ["/", "/inbox", "/drafts", "/approvals", "/tasks", "/archive", "/agent", "/activity", "/settings"];

export function proxy(request: NextRequest): NextResponse {
  const requestId = randomUUID();
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);

  const cookieName = process.env.NODE_ENV === "production" ? "__Host-mailpilot_session" : "mailpilot_session";
  const path = request.nextUrl.pathname;
  const isProtectedPage = PROTECTED_PATHS.some((protectedPath) =>
    protectedPath === "/" ? path === "/" : path === protectedPath || path.startsWith(`${protectedPath}/`)
  );
  let response: NextResponse;

  if (isProtectedPage && !request.cookies.has(cookieName)) {
    const signInUrl = request.nextUrl.clone();
    signInUrl.pathname = "/sign-in";
    signInUrl.search = "";
    signInUrl.searchParams.set("returnTo", path);
    response = NextResponse.redirect(signInUrl);
    response.headers.set("Cache-Control", "no-store");
  } else {
    response = NextResponse.next({ request: { headers } });
  }

  response.headers.set("x-request-id", requestId);
  console.info(JSON.stringify({
    level: "info",
    event: "request.received",
    service: "web",
    requestId,
    method: request.method,
    path: request.nextUrl.pathname
  }));
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
