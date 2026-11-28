import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { GmailConnectionResponseSchema } from "@mailpilot/shared";
import type { Logger } from "pino";
import { appendCookie, expireCookie, readCookie } from "../auth/cookies.js";
import { createRequireAuthentication, createRequireCsrf } from "../auth/middleware.js";
import { matchesCurrentOAuthSession } from "../auth/oauth-session.js";
import type { AuthStore } from "../auth/types.js";
import { apiEnvironment } from "../environment.js";
import { ApiError } from "../errors.js";
import { logger as defaultLogger } from "../logger.js";
import { GoogleGmailOAuthUnavailableError } from "./google-oauth.js";
import {
  getGmailOAuthCookieName,
  normalizeReturnPath,
  signGmailOAuthTransaction,
  verifyGmailOAuthTransaction
} from "./oauth-state.js";
import type { GmailConnectionStore, GmailOAuthClient } from "./types.js";

const GMAIL_SCOPE = "openid email https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_TRANSACTION_TTL_SECONDS = 600;
const GMAIL_CALLBACK_PATH = "/v1/oauth/google/callback";

export interface GmailRouterDependencies {
  store: GmailConnectionStore;
  authStore: AuthStore;
  oauthClient: GmailOAuthClient;
  cancelSyncsForConnection?: (userId: string, connectionId: string) => Promise<void>;
  webOrigin?: string;
  apiPublicOrigin?: string;
  sessionSecret?: string;
  secureCookies?: boolean;
  now?: () => Date;
  logger?: Logger;
}

export function createGmailRouter(dependencies: GmailRouterDependencies): Router {
  const router = Router();
  const webOrigin = dependencies.webOrigin ?? apiEnvironment.WEB_ORIGIN;
  const apiPublicOrigin = dependencies.apiPublicOrigin ?? apiEnvironment.API_PUBLIC_ORIGIN;
  const sessionSecret = dependencies.sessionSecret ?? apiEnvironment.SESSION_SECRET;
  const secureCookies = dependencies.secureCookies ?? apiEnvironment.NODE_ENV === "production";
  const now = dependencies.now ?? (() => new Date());
  const logger = dependencies.logger ?? defaultLogger;
  const cookieName = getGmailOAuthCookieName(secureCookies);

  const requireAuthentication = createRequireAuthentication({
    store: dependencies.authStore,
    secureCookies,
    webOrigin,
    now
  });
  const requireCsrf = createRequireCsrf(webOrigin, secureCookies);

  router.get("/connect", requireAuthentication, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const authContext = request.authContext;
    if (!authContext) {
      throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
    }

    const currentTime = now();
    const transaction = {
      state: randomBytes(32).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"),
      codeVerifier: randomBytes(48).toString("base64url"),
      issuedAt: currentTime.getTime(),
      sessionId: authContext.sessionId,
      userId: authContext.userId,
      returnTo: normalizeReturnPath(request.query.returnTo)
    };

    try {
      const authorizationUrl = await dependencies.oauthClient.buildAuthorizationUrl({
        state: transaction.state,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
        redirectUri: new URL(GMAIL_CALLBACK_PATH, apiPublicOrigin).toString(),
        scope: GMAIL_SCOPE
      });

      appendCookie(response, cookieName, signGmailOAuthTransaction(transaction, sessionSecret), {
        maxAgeSeconds: GMAIL_TRANSACTION_TTL_SECONDS,
        secure: secureCookies,
        httpOnly: true,
        sameSite: "Lax"
      });

      response.redirect(302, authorizationUrl.toString());
    } catch (error: unknown) {
      logger.warn(
        { requestId: response.locals.requestId, code: "GMAIL_OAUTH_START_FAILED" },
        "gmail.connect_start_failed"
      );
      const errorCode = error instanceof GoogleGmailOAuthUnavailableError ? "unavailable" : "oauth_failed";
      const redirectUrl = new URL(transaction.returnTo, webOrigin);
      redirectUrl.searchParams.set("error", errorCode);
      response.redirect(303, redirectUrl.toString());
    }
  });

  router.get("/connection", requireAuthentication, async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    const authContext = request.authContext;
    if (!authContext) {
      throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
    }

    try {
      const record = await dependencies.store.getConnection(authContext.userId);
      if (!record || record.status === "disconnected") {
        response.status(200).json(
          GmailConnectionResponseSchema.parse({
            connection: record
              ? {
                  email: record.providerEmailNormalized,
                  status: "disconnected",
                  grantedScopes: record.grantedScopes,
                  connectedAt: record.connectedAt.toISOString(),
                  disconnectedAt: record.disconnectedAt?.toISOString() ?? null,
                  lastSuccessfulSyncAt: record.lastSuccessfulSyncAt?.toISOString() ?? null,
                  reauthRequired: false
                }
              : null
          })
        );
        return;
      }

      response.status(200).json(
        GmailConnectionResponseSchema.parse({
          connection: {
            email: record.providerEmailNormalized,
            status: record.status,
            grantedScopes: record.grantedScopes,
            connectedAt: record.connectedAt.toISOString(),
            disconnectedAt: record.disconnectedAt?.toISOString() ?? null,
            lastSuccessfulSyncAt: record.lastSuccessfulSyncAt?.toISOString() ?? null,
            reauthRequired: record.status === "reauth_required"
          }
        })
      );
    } catch (error: unknown) {
      next(error);
    }
  });

  router.delete("/connection", requireAuthentication, requireCsrf, async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    const authContext = request.authContext;
    if (!authContext) {
      throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
    }

    const currentTime = now();
    try {
      const connection = await dependencies.store.getConnection(authContext.userId);
      if (connection) {
        await dependencies.cancelSyncsForConnection?.(authContext.userId, connection.id);
      }
      const refreshToken = await dependencies.store.getDecryptedRefreshToken(authContext.userId);
      if (refreshToken) {
        await dependencies.oauthClient.revokeToken(refreshToken);
      }
      await dependencies.store.disconnectGmail(authContext.userId, currentTime);
      logger.info({ requestId: response.locals.requestId, userId: authContext.userId }, "gmail.disconnected");
      response.status(204).end();
    } catch (error: unknown) {
      next(error);
    }
  });

  return router;
}

export function createGmailCallbackRouter(dependencies: GmailRouterDependencies): Router {
  const router = Router();
  const webOrigin = dependencies.webOrigin ?? apiEnvironment.WEB_ORIGIN;
  const apiPublicOrigin = dependencies.apiPublicOrigin ?? apiEnvironment.API_PUBLIC_ORIGIN;
  const sessionSecret = dependencies.sessionSecret ?? apiEnvironment.SESSION_SECRET;
  const secureCookies = dependencies.secureCookies ?? apiEnvironment.NODE_ENV === "production";
  const now = dependencies.now ?? (() => new Date());
  const logger = dependencies.logger ?? defaultLogger;
  const cookieName = getGmailOAuthCookieName(secureCookies);

  router.get("/google/callback", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    expireCookie(response, cookieName, secureCookies, true, "Lax");

    const currentTime = now();
    const transaction = verifyGmailOAuthTransaction(
      readCookie(request.headers.cookie, cookieName),
      sessionSecret,
      currentTime
    );

    const state = typeof request.query.state === "string" ? request.query.state : undefined;
    if (!transaction || !state || !constantTimeEqual(transaction.state, state)) {
      logger.warn({ requestId: response.locals.requestId }, "gmail.callback_invalid_state");
      response.redirect(303, errorRedirectUrl(webOrigin, "/settings", "invalid_state"));
      return;
    }

    try {
      const sessionMatches = await matchesCurrentOAuthSession({
        authStore: dependencies.authStore,
        cookieHeader: request.headers.cookie,
        secureCookies,
        sessionId: transaction.sessionId,
        userId: transaction.userId,
        now: currentTime
      });
      if (!sessionMatches) {
        logger.warn({ requestId: response.locals.requestId }, "gmail.callback_session_mismatch");
        response.redirect(303, errorRedirectUrl(webOrigin, transaction.returnTo, "invalid_state"));
        return;
      }
    } catch (error: unknown) {
      logger.error({
        requestId: response.locals.requestId,
        errorType: error instanceof Error ? error.name : "UnknownError"
      }, "gmail.callback_session_check_failed");
      response.redirect(303, errorRedirectUrl(webOrigin, transaction.returnTo, "oauth_failed"));
      return;
    }

    if (typeof request.query.error === "string") {
      const isDenied = request.query.error === "access_denied";
      logger.warn(
        { requestId: response.locals.requestId, error: isDenied ? "access_denied" : "oauth_error" },
        "gmail.callback_provider_error"
      );
      response.redirect(
        303,
        errorRedirectUrl(webOrigin, transaction.returnTo, isDenied ? "access_denied" : "oauth_failed")
      );
      return;
    }

    const code = typeof request.query.code === "string" ? request.query.code : undefined;
    if (!code || code.length > 2048) {
      logger.warn({ requestId: response.locals.requestId }, "gmail.callback_missing_code");
      response.redirect(303, errorRedirectUrl(webOrigin, transaction.returnTo, "invalid_code"));
      return;
    }

    try {
      const callbackUrl = new URL(request.originalUrl, apiPublicOrigin);
      const exchange = await dependencies.oauthClient.exchangeAuthorizationCode(callbackUrl, {
        state: transaction.state,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier
      });

      if (!exchange.emailVerified) {
        response.redirect(303, errorRedirectUrl(webOrigin, transaction.returnTo, "unverified_account"));
        return;
      }
      if (!exchange.grantedScopes.includes(GMAIL_READONLY_SCOPE)) {
        response.redirect(303, errorRedirectUrl(webOrigin, transaction.returnTo, "scope_missing"));
        return;
      }

      await dependencies.store.connectGmail({
        userId: transaction.userId,
        subject: exchange.subject,
        email: exchange.email,
        refreshToken: exchange.refreshToken,
        grantedScopes: exchange.grantedScopes,
        connectedAt: currentTime
      });

      logger.info(
        { requestId: response.locals.requestId, userId: transaction.userId },
        "gmail.connected_successfully"
      );

      const targetUrl = new URL(transaction.returnTo, webOrigin);
      targetUrl.searchParams.set("gmail", "connected");
      response.redirect(303, targetUrl.toString());
    } catch (error: unknown) {
      logger.error(
        {
          requestId: response.locals.requestId,
          errorType: error instanceof Error ? error.name : "UnknownError"
        },
        "gmail.callback_exchange_failed"
      );
      response.redirect(303, errorRedirectUrl(webOrigin, transaction.returnTo, "oauth_failed"));
    }
  });

  return router;
}

function errorRedirectUrl(webOrigin: string, returnTo: string, errorCode: string): string {
  const url = new URL(normalizeReturnPath(returnTo), webOrigin);
  url.searchParams.set("error", errorCode);
  return url.toString();
}

function constantTimeEqual(first: string, second: string): boolean {
  const firstBuffer = Buffer.from(first);
  const secondBuffer = Buffer.from(second);
  return firstBuffer.length === secondBuffer.length && timingSafeEqual(firstBuffer, secondBuffer);
}

