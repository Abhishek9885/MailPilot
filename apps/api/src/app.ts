import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { ServiceHealthSchema } from "@mailpilot/shared";
import { prisma } from "./database.js";
import { apiEnvironment } from "./environment.js";
import { ApiError } from "./errors.js";
import { logger as defaultLogger } from "./logger.js";
import { createGoogleOidcClient } from "./auth/google-oidc.js";
import { createRequireAuthentication } from "./auth/middleware.js";
import { PrismaAuthStore } from "./auth/prisma-store.js";
import { createAuthRouter } from "./auth/router.js";
import type { AuthStore, GoogleOidcClient } from "./auth/types.js";
import { PrismaGmailConnectionStore } from "./gmail/connection-store.js";
import { createGoogleGmailOAuthClient } from "./gmail/google-oauth.js";
import { createGmailCallbackRouter, createGmailRouter } from "./gmail/router.js";
import { GmailClient } from "./gmail/client.js";
import { PrismaEmailStore } from "./emails/email-store.js";
import { createEmailRouter } from "./emails/router.js";
import { EmailQueryService } from "./emails/email-query.js";
import { createRefreshingTokenProvider } from "./gmail/token-provider.js";
import { PrismaGmailSyncRunStore } from "./gmail/sync-store.js";
import { GmailSyncService } from "./gmail/sync-service.js";
import { createGmailSyncRouter } from "./gmail/sync-router.js";
import type { GmailConnectionStore, GmailOAuthClient } from "./gmail/types.js";
import type { Logger } from "pino";
import { FastApiEmailAnalysisClient } from "./analysis/email-analysis-client.js";
import { EmailAnalysisService } from "./analysis/email-analysis-service.js";
import { PrismaEmailAnalysisStore } from "./analysis/email-analysis-store.js";
import { createEmailAnalysisRouter } from "./analysis/router.js";
import { FastApiReplyDraftClient } from "./replies/reply-draft-client.js";
import { createReplyDraftRouter } from "./replies/router.js";
import { ReplyDraftService } from "./replies/reply-draft-service.js";
import { PrismaReplyDraftStore } from "./replies/reply-draft-store.js";

export interface AppDependencies {
  checkDatabase: () => Promise<void>;
  authStore?: AuthStore;
  oidcClient?: GoogleOidcClient;
  gmailStore?: GmailConnectionStore;
  gmailOAuthClient?: GmailOAuthClient;
  gmailSyncService?: GmailSyncService;
  emailAnalysisService?: EmailAnalysisService;
  replyDraftService?: ReplyDraftService;
  logger?: Logger;
}

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createApp({
  checkDatabase,
  authStore: providedAuthStore,
  oidcClient: providedOidcClient,
  gmailStore: providedGmailStore,
  gmailOAuthClient: providedGmailOAuthClient,
  gmailSyncService: providedGmailSyncService,
  emailAnalysisService: providedEmailAnalysisService,
  replyDraftService: providedReplyDraftService,
  logger = defaultLogger
}: AppDependencies): express.Express {
  const app = express();
  const authStore = providedAuthStore ?? new PrismaAuthStore(prisma);
  const oidcClient = providedOidcClient ?? createGoogleOidcClient({
    clientId: apiEnvironment.GOOGLE_OIDC_CLIENT_ID,
    clientSecret: apiEnvironment.GOOGLE_OIDC_CLIENT_SECRET
  });
  const gmailStore = providedGmailStore ?? new PrismaGmailConnectionStore(prisma, apiEnvironment.GMAIL_TOKEN_ENCRYPTION_KEY);
  const gmailOAuthClient = providedGmailOAuthClient ?? createGoogleGmailOAuthClient({
    clientId: apiEnvironment.GOOGLE_GMAIL_OAUTH_CLIENT_ID,
    clientSecret: apiEnvironment.GOOGLE_GMAIL_OAUTH_CLIENT_SECRET
  });
  const gmailSyncService = providedGmailSyncService ?? new GmailSyncService({
    store: new PrismaGmailSyncRunStore(prisma),
    emailStore: new PrismaEmailStore(prisma),
    clientForUser: (userId) => new GmailClient({
      tokenProvider: createRefreshingTokenProvider({
        userId,
        connectionStore: gmailStore,
        oauthClient: gmailOAuthClient
      }),
      logger
    })
  });
  const emailAnalysisService = providedEmailAnalysisService ?? new EmailAnalysisService(
    new PrismaEmailAnalysisStore(prisma),
    new FastApiEmailAnalysisClient(
      apiEnvironment.AI_SERVICE_URL,
      apiEnvironment.AI_SERVICE_TOKEN,
      apiEnvironment.AI_SERVICE_TIMEOUT_MS
    )
  );
  const replyDraftService = providedReplyDraftService ?? new ReplyDraftService(
    new PrismaReplyDraftStore(prisma),
    new FastApiReplyDraftClient(
      apiEnvironment.AI_SERVICE_URL,
      apiEnvironment.AI_SERVICE_TOKEN,
      apiEnvironment.AI_SERVICE_TIMEOUT_MS
    )
  );
  app.disable("x-powered-by");
  const requestContext: RequestHandler = (request, response, next) => {
    const providedRequestId = request.header("x-request-id");
    const requestId = providedRequestId && REQUEST_ID_PATTERN.test(providedRequestId)
      ? providedRequestId
      : randomUUID();
    response.locals.requestId = requestId;
    response.setHeader("x-request-id", requestId);
    const startedAt = process.hrtime.bigint();
    response.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      logger.info({
        requestId,
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Number(durationMs.toFixed(2))
      }, "request.completed");
    });
    next();
  };
  app.use(requestContext);
  app.use(cors({ origin: apiEnvironment.WEB_ORIGIN, credentials: true, maxAge: 600 }));
  app.use(express.json({ limit: "64kb" }));

  app.get("/health/live", (_request, response) => {
    response.status(200).json(ServiceHealthSchema.parse({
      service: "api",
      status: "ok",
      requestId: response.locals.requestId
    }));
  });

  app.get("/health/ready", async (_request, response) => {
    try {
      await checkDatabase();
      response.status(200).json(ServiceHealthSchema.parse({
        service: "api",
        status: "ok",
        requestId: response.locals.requestId
      }));
    } catch {
      logger.warn({ requestId: response.locals.requestId }, "health.database_unavailable");
      response.status(503).json(ServiceHealthSchema.parse({
        service: "api",
        status: "unavailable",
        requestId: response.locals.requestId
      }));
    }
  });

  app.use("/v1/auth", createAuthRouter({ store: authStore, oidcClient, logger }));
  app.use("/v1/oauth", createGmailCallbackRouter({
    store: gmailStore,
    authStore,
    oauthClient: gmailOAuthClient,
    logger
  }));
  app.use("/v1/gmail", createGmailRouter({
    store: gmailStore,
    authStore,
    oauthClient: gmailOAuthClient,
    cancelSyncsForConnection: async (userId, connectionId) => {
      await gmailSyncService.cancelActiveForConnection(userId, connectionId);
    },
    logger
  }));
  app.use("/v1/syncs", createGmailSyncRouter({ service: gmailSyncService, authStore }));
  app.use("/v1", createRequireAuthentication({
    store: authStore,
    secureCookies: apiEnvironment.NODE_ENV === "production",
    webOrigin: apiEnvironment.WEB_ORIGIN
  }));
  app.use("/v1/emails", createEmailAnalysisRouter({
    service: emailAnalysisService,
    webOrigin: apiEnvironment.WEB_ORIGIN,
    secureCookies: apiEnvironment.NODE_ENV === "production"
  }));
  app.use("/v1/emails", createEmailRouter(new EmailQueryService(prisma)));
  app.use("/v1/emails", createReplyDraftRouter({
    service: replyDraftService,
    webOrigin: apiEnvironment.WEB_ORIGIN,
    secureCookies: apiEnvironment.NODE_ENV === "production"
  }));

  app.get("/v1", (_request, response) => {
    response.status(200).json({
      service: "api",
      status: "placeholder",
      capabilities: { gmail: true, emailAnalysis: true, replyDrafts: true, backgroundJobs: false }
    });
  });

  app.use((_request, _response, next) => next(new ApiError(404, "NOT_FOUND", "Route not found")));

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    void _next;
    const requestId = typeof response.locals.requestId === "string" ? response.locals.requestId : randomUUID();
    const apiError = error instanceof ApiError
      ? error
      : isJsonParseError(error)
        ? new ApiError(400, "INVALID_ARGUMENT", "Request body must be valid JSON")
        : undefined;
    const statusCode = apiError?.statusCode ?? 500;
    const code = apiError?.code ?? "INTERNAL";
    const message = apiError?.message ?? "An unexpected error occurred";

    logger.error({ requestId, statusCode, code, errorType: error instanceof Error ? error.name : "UnknownError" }, "request.failed");
    if (response.headersSent) return;
    if (apiError?.retryAfterSeconds !== undefined) {
      response.setHeader("Retry-After", String(Math.max(1, apiError.retryAfterSeconds)));
    }

    response.status(statusCode).json({
      error: { code, message, requestId, retryable: apiError?.retryable ?? false, details: {} }
    });
  };

  app.use(errorHandler);
  return app;
}

function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError && "type" in error && error.type === "entity.parse.failed";
}
