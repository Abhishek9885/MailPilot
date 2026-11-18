import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { AppSessionResponseSchema } from "@mailpilot/shared";
import type { Logger } from "pino";
import { apiEnvironment } from "../environment.js";
import { ApiError } from "../errors.js";
import { logger as defaultLogger } from "../logger.js";
import { appendCookie, clearAuthCookies, getAuthCookieNames, hashSecret, readCookie, expireCookie } from "./cookies.js";
import { GoogleOidcUnavailableError } from "./google-oidc.js";
import { createRequireAuthentication, createRequireCsrf } from "./middleware.js";
import { normalizeReturnPath, signOAuthTransaction, verifyOAuthTransaction } from "./oauth-state.js";
import type { AuthStore, GoogleOidcClient } from "./types.js";
import { AuthenticationRejectedError } from "./types.js";

const AUTH_SCOPE = "openid email";
const LOGIN_TRANSACTION_TTL_SECONDS = 600;
const GOOGLE_CALLBACK_PATH = "/v1/auth/google/callback";

export interface AuthRouterOptions {
  store: AuthStore;
  oidcClient: GoogleOidcClient;
  webOrigin?: string;
  apiPublicOrigin?: string;
  sessionSecret?: string;
  sessionTtlSeconds?: number;
  secureCookies?: boolean;
  now?: () => Date;
  logger?: Logger;
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const router = Router();
  const webOrigin = options.webOrigin ?? apiEnvironment.WEB_ORIGIN;
  const apiPublicOrigin = options.apiPublicOrigin ?? apiEnvironment.API_PUBLIC_ORIGIN;
  const sessionSecret = options.sessionSecret ?? apiEnvironment.SESSION_SECRET;
  const sessionTtlSeconds = options.sessionTtlSeconds ?? apiEnvironment.SESSION_TTL_SECONDS;
  const secureCookies = options.secureCookies ?? apiEnvironment.NODE_ENV === "production";
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? defaultLogger;
  const cookieNames = getAuthCookieNames(secureCookies);
  const requireAuthentication = createRequireAuthentication({ store: options.store, secureCookies, webOrigin, now });
  const requireCsrf = createRequireCsrf(webOrigin, secureCookies);

  router.get("/google/start", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const currentTime = now();
    const transaction = {
      state: randomBytes(32).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"),
      codeVerifier: randomBytes(48).toString("base64url"),
      issuedAt: currentTime.getTime(),
      returnTo: normalizeReturnPath(request.query.returnTo)
    };

    try {
      const authorizationUrl = await options.oidcClient.buildAuthorizationUrl({
        state: transaction.state,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
        redirectUri: new URL(GOOGLE_CALLBACK_PATH, apiPublicOrigin).toString(),
        scope: AUTH_SCOPE
      });
      appendCookie(response, cookieNames.transaction, signOAuthTransaction(transaction, sessionSecret), {
        maxAgeSeconds: LOGIN_TRANSACTION_TTL_SECONDS,
        secure: secureCookies,
        httpOnly: true,
        sameSite: "Lax"
      });
      response.redirect(302, authorizationUrl.toString());
    } catch (error: unknown) {
      logger.warn({ requestId: response.locals.requestId, code: "GOOGLE_SIGN_IN_UNAVAILABLE" }, "auth.google_start_failed");
      const errorCode = error instanceof GoogleOidcUnavailableError ? "unavailable" : "sign_in_failed";
      response.redirect(303, signInUrl(webOrigin, errorCode));
    }
  });

  router.get("/google/callback", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    expireCookie(response, cookieNames.transaction, secureCookies, true, "Lax");

    const currentTime = now();
    const transaction = verifyOAuthTransaction(
      readCookie(request.headers.cookie, cookieNames.transaction),
      sessionSecret,
      currentTime
    );
    const state = typeof request.query.state === "string" ? request.query.state : undefined;
    if (!transaction || !state || !constantTimeEqual(transaction.state, state)) {
      response.redirect(303, signInUrl(webOrigin, "sign_in_failed"));
      return;
    }

    if (typeof request.query.error === "string") {
      response.redirect(303, signInUrl(webOrigin, request.query.error === "access_denied" ? "sign_in_cancelled" : "sign_in_failed"));
      return;
    }

    const code = typeof request.query.code === "string" ? request.query.code : undefined;
    if (!code || code.length > 2048) {
      response.redirect(303, signInUrl(webOrigin, "sign_in_failed"));
      return;
    }

    try {
      const callbackUrl = new URL(request.originalUrl, apiPublicOrigin);
      const identity = await options.oidcClient.exchangeAuthorizationCode(callbackUrl, {
        state: transaction.state,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier
      });
      if (!isTrustedGoogleIdentity(identity)) throw new AuthenticationRejectedError();

      const user = await options.store.authenticateGoogleIdentity({
        ...identity,
        email: identity.email.trim().toLowerCase()
      }, currentTime);
      if (user.status !== "active") throw new AuthenticationRejectedError();

      const sessionToken = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(currentTime.getTime() + sessionTtlSeconds * 1000);
      await options.store.createSession({
        userId: user.id,
        tokenHash: hashSecret(sessionToken),
        csrfTokenHash: hashSecret(csrfToken),
        createdAt: currentTime,
        expiresAt
      });

      appendCookie(response, cookieNames.session, sessionToken, {
        maxAgeSeconds: sessionTtlSeconds,
        secure: secureCookies,
        httpOnly: true,
        sameSite: "Lax"
      });
      appendCookie(response, cookieNames.csrf, csrfToken, {
        maxAgeSeconds: sessionTtlSeconds,
        secure: secureCookies,
        httpOnly: false,
        sameSite: "Strict"
      });
      response.redirect(303, new URL(transaction.returnTo, webOrigin).toString());
    } catch (error: unknown) {
      logger.warn({ requestId: response.locals.requestId, code: error instanceof AuthenticationRejectedError ? "IDENTITY_REJECTED" : "OIDC_CALLBACK_FAILED" }, "auth.google_callback_failed");
      response.redirect(303, signInUrl(webOrigin, "sign_in_failed"));
    }
  });

  router.get("/session", requireAuthentication, (request, response) => {
    const authContext = request.authContext;
    if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
    response.status(200).json(AppSessionResponseSchema.parse({
      user: { id: authContext.userId, email: authContext.email }
    }));
  });

  router.post("/sign-out", requireAuthentication, requireCsrf, async (request, response) => {
    const authContext = request.authContext;
    if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
    await options.store.revokeSession(authContext.sessionId, authContext.userId, now());
    clearAuthCookies(response, cookieNames, secureCookies);
    response.status(204).end();
  });

  return router;
}

function isTrustedGoogleIdentity(identity: { email: string; emailVerified: boolean; hostedDomain?: string }): boolean {
  const emailDomain = identity.email.split("@").at(-1)?.toLowerCase();
  const googleHosted = emailDomain === "gmail.com" || Boolean(identity.hostedDomain);
  return identity.emailVerified && googleHosted;
}

function signInUrl(webOrigin: string, errorCode: string): string {
  const url = new URL("/sign-in", webOrigin);
  url.searchParams.set("error", errorCode);
  return url.toString();
}

function constantTimeEqual(first: string, second: string): boolean {
  const firstBuffer = Buffer.from(first);
  const secondBuffer = Buffer.from(second);
  return firstBuffer.length === secondBuffer.length && timingSafeEqual(firstBuffer, secondBuffer);
}
