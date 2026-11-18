import { createHash } from "node:crypto";
import type { Response } from "express";

export interface AuthCookieNames {
  session: string;
  csrf: string;
  transaction: string;
}

export function getAuthCookieNames(secure: boolean): AuthCookieNames {
  const prefix = secure ? "__Host-" : "";
  return {
    session: `${prefix}mailpilot_session`,
    csrf: `${prefix}mailpilot_csrf`,
    transaction: `${prefix}mailpilot_login`
  };
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
  }
  return undefined;
}

export function appendCookie(
  response: Response,
  name: string,
  value: string,
  options: { maxAgeSeconds: number; secure: boolean; httpOnly: boolean; sameSite: "Lax" | "Strict" }
): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${options.maxAgeSeconds}`,
    `SameSite=${options.sameSite}`
  ];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  response.append("Set-Cookie", parts.join("; "));
}

export function expireCookie(response: Response, name: string, secure: boolean, httpOnly: boolean, sameSite: "Lax" | "Strict"): void {
  const parts = [
    `${name}=`,
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    `SameSite=${sameSite}`
  ];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  response.append("Set-Cookie", parts.join("; "));
}

export function clearAuthCookies(response: Response, names: AuthCookieNames, secure: boolean, includeTransaction = false): void {
  expireCookie(response, names.session, secure, true, "Lax");
  expireCookie(response, names.csrf, secure, false, "Strict");
  if (includeTransaction) expireCookie(response, names.transaction, secure, true, "Lax");
}
