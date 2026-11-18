import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { ApiError } from "../errors.js";
import { clearAuthCookies, getAuthCookieNames, hashSecret, readCookie } from "./cookies.js";
import type { AuthContext, AuthStore } from "./types.js";

/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    interface Request {
      authContext?: AuthContext;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */

export interface SessionMiddlewareOptions {
  store: AuthStore;
  secureCookies: boolean;
  webOrigin: string;
  now?: () => Date;
}

export function createRequireAuthentication(options: SessionMiddlewareOptions): RequestHandler {
  const cookieNames = getAuthCookieNames(options.secureCookies);
  const now = options.now ?? (() => new Date());

  return async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    const rawToken = readCookie(request.headers.cookie, cookieNames.session);
    if (!rawToken || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) {
      clearAuthCookies(response, cookieNames, options.secureCookies);
      next(new ApiError(401, "UNAUTHORIZED", "Sign-in is required"));
      return;
    }

    try {
      const session = await options.store.findSessionByTokenHash(hashSecret(rawToken));
      const currentTime = now();
      const valid = session
        && !session.revokedAt
        && session.expiresAt.getTime() > currentTime.getTime()
        && session.user.status === "active";

      if (!valid) {
        if (session && !session.revokedAt) {
          await options.store.revokeSession(session.id, session.userId, currentTime);
        }
        clearAuthCookies(response, cookieNames, options.secureCookies);
        next(new ApiError(401, "UNAUTHORIZED", "Sign-in is required"));
        return;
      }

      request.authContext = {
        sessionId: session.id,
        userId: session.userId,
        email: session.user.emailNormalized,
        csrfTokenHash: session.csrfTokenHash
      };
      next();
    } catch (error: unknown) {
      next(error);
    }
  };
}

export function createRequireCsrf(webOrigin: string, secureCookies: boolean): RequestHandler {
  const expectedOrigin = new URL(webOrigin).origin;

  return (request, _response, next) => {
    const authContext = request.authContext;
    const origin = request.get("origin");
    const csrfCookie = readCookie(request.headers.cookie, getAuthCookieNames(secureCookies).csrf);
    const csrfHeader = request.get("x-csrf-token");

    if (!authContext || !origin || !csrfCookie || !csrfHeader || !authContext.csrfTokenHash) {
      next(new ApiError(403, "CSRF_REJECTED", "Request could not be verified"));
      return;
    }

    let requestOrigin: string;
    try {
      requestOrigin = new URL(origin).origin;
    } catch {
      next(new ApiError(403, "CSRF_REJECTED", "Request could not be verified"));
      return;
    }

    const headerMatchesCookie = constantTimeEqual(csrfCookie, csrfHeader);
    const cookieMatchesSession = constantTimeEqual(hashSecret(csrfCookie), authContext.csrfTokenHash);
    if (requestOrigin !== expectedOrigin || !headerMatchesCookie || !cookieMatchesSession) {
      next(new ApiError(403, "CSRF_REJECTED", "Request could not be verified"));
      return;
    }

    next();
  };
}

function constantTimeEqual(first: string, second: string): boolean {
  const firstBuffer = Buffer.from(first);
  const secondBuffer = Buffer.from(second);
  return firstBuffer.length === secondBuffer.length && timingSafeEqual(firstBuffer, secondBuffer);
}
