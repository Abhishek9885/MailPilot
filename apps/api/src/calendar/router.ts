import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { GoogleCalendarConnectionResponseSchema, GoogleCalendarScope } from "@mailpilot/shared";
import type { Logger } from "pino";
import { appendCookie, expireCookie, readCookie } from "../auth/cookies.js";
import { createRequireAuthentication, createRequireCsrf } from "../auth/middleware.js";
import { matchesCurrentOAuthSession } from "../auth/oauth-session.js";
import type { AuthStore } from "../auth/types.js";
import { apiEnvironment } from "../environment.js";
import { ApiError } from "../errors.js";
import { logger as defaultLogger } from "../logger.js";
import { GoogleCalendarOAuthUnavailableError, type GoogleCalendarOAuthClient } from "./google-oauth.js";
import {
  getCalendarOAuthCookieName,
  signCalendarOAuthTransaction,
  verifyCalendarOAuthTransaction
} from "./oauth-state.js";
import type { GoogleCalendarConnectionStore } from "./types.js";

const CALENDAR_CALLBACK_PATH = "/v1/oauth/google-calendar/callback";
const TRANSACTION_TTL_SECONDS = 600;

export interface GoogleCalendarRouterOptions {
  store: GoogleCalendarConnectionStore;
  authStore: AuthStore;
  oauthClient: GoogleCalendarOAuthClient;
  webOrigin?: string;
  apiPublicOrigin?: string;
  sessionSecret?: string;
  secureCookies?: boolean;
  eventCreationEnabled?: boolean;
  now?: () => Date;
  logger?: Logger;
}

export function createGoogleCalendarRouter(options: GoogleCalendarRouterOptions): Router {
  const router = Router();
  const webOrigin = options.webOrigin ?? apiEnvironment.WEB_ORIGIN;
  const apiPublicOrigin = options.apiPublicOrigin ?? apiEnvironment.API_PUBLIC_ORIGIN;
  const sessionSecret = options.sessionSecret ?? apiEnvironment.SESSION_SECRET;
  const secureCookies = options.secureCookies ?? apiEnvironment.NODE_ENV === "production";
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? defaultLogger;
  const cookieName = getCalendarOAuthCookieName(secureCookies);
  const authentication = createRequireAuthentication({ store: options.authStore, secureCookies, webOrigin, now });
  const csrf = createRequireCsrf(webOrigin, secureCookies);
  const eventCreationEnabled = options.eventCreationEnabled ?? apiEnvironment.GOOGLE_CALENDAR_EVENTS_ENABLED;

  router.get("/connect", authentication, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!request.authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
    const transaction = {
      state: randomBytes(32).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"),
      codeVerifier: randomBytes(48).toString("base64url"),
      issuedAt: now().getTime(),
      sessionId: request.authContext.sessionId,
      userId: request.authContext.userId,
      returnTo: "/settings"
    };
    try {
      const authorizationUrl = await options.oauthClient.buildAuthorizationUrl({
        state: transaction.state,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
        redirectUri: new URL(CALENDAR_CALLBACK_PATH, apiPublicOrigin).toString()
      });
      appendCookie(response, cookieName, signCalendarOAuthTransaction(transaction, sessionSecret), {
        maxAgeSeconds: TRANSACTION_TTL_SECONDS,
        secure: secureCookies,
        httpOnly: true,
        sameSite: "Lax"
      });
      response.redirect(302, authorizationUrl.toString());
    } catch (error: unknown) {
      logger.warn({ requestId: response.locals.requestId, code: "GOOGLE_CALENDAR_OAUTH_START_FAILED" }, "calendar.connect_start_failed");
      const url = new URL("/settings", webOrigin);
      url.searchParams.set("calendar_error", error instanceof GoogleCalendarOAuthUnavailableError ? "unavailable" : "oauth_failed");
      response.redirect(303, url.toString());
    }
  });

  router.get("/connection", authentication, async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      if (!request.authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const record = await options.store.getConnection(request.authContext.userId);
      response.status(200).json(GoogleCalendarConnectionResponseSchema.parse({
        connection: record ? {
          email: record.email,
          status: record.status,
          grantedScopes: record.grantedScopes,
          connectedAt: record.connectedAt.toISOString(),
          disconnectedAt: record.disconnectedAt?.toISOString() ?? null,
          reauthRequired: record.status === "reauth_required"
        } : null,
        eventCreationEnabled
      }));
    } catch (error: unknown) {
      next(error);
    }
  });

  router.delete("/connection", authentication, csrf, async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      if (!request.authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const userId = request.authContext.userId;
      const refreshToken = await options.store.getDecryptedRefreshToken(userId);
      if (refreshToken) await options.oauthClient.revokeToken(refreshToken);
      await options.store.disconnectCalendar(userId, now());
      logger.info({ requestId: response.locals.requestId, userId }, "calendar.disconnected");
      response.status(204).end();
    } catch (error: unknown) {
      next(error);
    }
  });

  return router;
}

export function createGoogleCalendarCallbackRouter(options: GoogleCalendarRouterOptions): Router {
  const router = Router();
  const webOrigin = options.webOrigin ?? apiEnvironment.WEB_ORIGIN;
  const apiPublicOrigin = options.apiPublicOrigin ?? apiEnvironment.API_PUBLIC_ORIGIN;
  const sessionSecret = options.sessionSecret ?? apiEnvironment.SESSION_SECRET;
  const secureCookies = options.secureCookies ?? apiEnvironment.NODE_ENV === "production";
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? defaultLogger;
  const cookieName = getCalendarOAuthCookieName(secureCookies);

  router.get("/google-calendar/callback", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    expireCookie(response, cookieName, secureCookies, true, "Lax");
    const currentTime = now();
    const transaction = verifyCalendarOAuthTransaction(
      readCookie(request.headers.cookie, cookieName), sessionSecret, currentTime
    );
    const state = typeof request.query.state === "string" ? request.query.state : undefined;
    if (!transaction || !state || !constantTimeEqual(transaction.state, state)) {
      logger.warn({ requestId: response.locals.requestId }, "calendar.callback_invalid_state");
      response.redirect(303, calendarErrorUrl(webOrigin, "invalid_state"));
      return;
    }
    try {
      const sessionMatches = await matchesCurrentOAuthSession({
        authStore: options.authStore,
        cookieHeader: request.headers.cookie,
        secureCookies,
        sessionId: transaction.sessionId,
        userId: transaction.userId,
        now: currentTime
      });
      if (!sessionMatches) {
        logger.warn({ requestId: response.locals.requestId }, "calendar.callback_session_mismatch");
        response.redirect(303, calendarErrorUrl(webOrigin, "invalid_state"));
        return;
      }
    } catch (error: unknown) {
      logger.error({
        requestId: response.locals.requestId,
        errorType: error instanceof Error ? error.name : "UnknownError"
      }, "calendar.callback_session_check_failed");
      response.redirect(303, calendarErrorUrl(webOrigin, "oauth_failed"));
      return;
    }
    if (typeof request.query.error === "string") {
      response.redirect(303, calendarErrorUrl(webOrigin, request.query.error === "access_denied" ? "access_denied" : "oauth_failed"));
      return;
    }
    const code = typeof request.query.code === "string" ? request.query.code : undefined;
    if (!code || code.length > 2048) {
      response.redirect(303, calendarErrorUrl(webOrigin, "invalid_code"));
      return;
    }

    try {
      const exchange = await options.oauthClient.exchangeAuthorizationCode(
        new URL(request.originalUrl, apiPublicOrigin),
        { state: transaction.state, nonce: transaction.nonce, codeVerifier: transaction.codeVerifier }
      );
      if (!exchange.emailVerified || !exchange.grantedScopes.includes(GoogleCalendarScope)) {
        response.redirect(303, calendarErrorUrl(webOrigin, "scope_missing"));
        return;
      }
      const currentToken = await options.store.getDecryptedRefreshToken(transaction.userId);
      if (!exchange.refreshToken && !currentToken) {
        response.redirect(303, calendarErrorUrl(webOrigin, "refresh_token_missing"));
        return;
      }
      await options.store.connectCalendar({
        userId: transaction.userId,
        subject: exchange.subject,
        email: exchange.email,
        refreshToken: exchange.refreshToken,
        grantedScopes: exchange.grantedScopes,
        connectedAt: currentTime
      });
      logger.info({ requestId: response.locals.requestId, userId: transaction.userId }, "calendar.connected_successfully");
      const url = new URL("/settings", webOrigin);
      url.searchParams.set("calendar", "connected");
      response.redirect(303, url.toString());
    } catch (error: unknown) {
      logger.warn({
        requestId: response.locals.requestId,
        errorType: error instanceof Error ? error.name : "UnknownError"
      }, "calendar.callback_exchange_failed");
      response.redirect(303, calendarErrorUrl(webOrigin, "oauth_failed"));
    }
  });
  return router;
}

function calendarErrorUrl(webOrigin: string, code: string): string {
  const url = new URL("/settings", webOrigin);
  url.searchParams.set("calendar_error", code);
  return url.toString();
}

function constantTimeEqual(first: string, second: string): boolean {
  const firstBuffer = Buffer.from(first);
  const secondBuffer = Buffer.from(second);
  return firstBuffer.length === secondBuffer.length && timingSafeEqual(firstBuffer, secondBuffer);
}
