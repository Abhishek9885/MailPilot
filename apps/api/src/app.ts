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
import { createEmailRouter } from "./emails/router.js";
import { EmailQueryService } from "./emails/email-query.js";
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
import { ActionProposalService } from "./actions/proposal-service.js";
import { PrismaActionProposalStore } from "./actions/proposal-store.js";
import { createActionProposalRouter } from "./actions/proposal-router.js";
import { TaskManagementService, PrismaTaskManagementStore } from "./tasks/task-management-service.js";
import { createTaskRouter } from "./tasks/router.js";
import { GoogleCalendarApi, type CalendarEventApi } from "./calendar/calendar-api.js";
import { CalendarActionRuntime } from "./calendar/action-executor.js";
import { PrismaGoogleCalendarConnectionStore } from "./calendar/connection-store.js";
import { createGoogleCalendarOAuthClient, type GoogleCalendarOAuthClient } from "./calendar/google-oauth.js";
import { createGoogleCalendarCallbackRouter, createGoogleCalendarRouter } from "./calendar/router.js";
import type { GoogleCalendarConnectionStore } from "./calendar/types.js";
import { MemoryManagementService } from "./memory/memory-service.js";
import { createMemoryRouter } from "./memory/router.js";
import { createGmailSyncService } from "./gmail/runtime.js";
import { FollowUpService } from "./followups/service.js";
import { createFollowUpRouter } from "./followups/router.js";
import { createRequestRateLimiter, type RateLimitStore } from "./security/rate-limit.js";

export interface AppDependencies {
  checkDatabase: () => Promise<void>;
  checkBackgroundWorker?: () => Promise<void>;
  authStore?: AuthStore;
  oidcClient?: GoogleOidcClient;
  gmailStore?: GmailConnectionStore;
  gmailOAuthClient?: GmailOAuthClient;
  gmailSyncService?: GmailSyncService;
  calendarStore?: GoogleCalendarConnectionStore;
  calendarOAuthClient?: GoogleCalendarOAuthClient;
  calendarEventApi?: CalendarEventApi;
  calendarEventCreationEnabled?: boolean;
  emailAnalysisService?: EmailAnalysisService;
  replyDraftService?: ReplyDraftService;
  actionProposalService?: ActionProposalService;
  taskManagementService?: TaskManagementService;
  memoryManagementService?: MemoryManagementService;
  followUpService?: FollowUpService;
  rateLimitStore?: RateLimitStore;
  logger?: Logger;
}

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createApp({
  checkDatabase,
  checkBackgroundWorker,
  authStore: providedAuthStore,
  oidcClient: providedOidcClient,
  gmailStore: providedGmailStore,
  gmailOAuthClient: providedGmailOAuthClient,
  gmailSyncService: providedGmailSyncService,
  calendarStore: providedCalendarStore,
  calendarOAuthClient: providedCalendarOAuthClient,
  calendarEventApi: providedCalendarEventApi,
  calendarEventCreationEnabled: providedCalendarEventCreationEnabled,
  emailAnalysisService: providedEmailAnalysisService,
  replyDraftService: providedReplyDraftService,
  actionProposalService: providedActionProposalService,
  taskManagementService: providedTaskManagementService,
  memoryManagementService: providedMemoryManagementService,
  followUpService: providedFollowUpService,
  rateLimitStore,
  logger = defaultLogger
}: AppDependencies): express.Express {
  const app = express();
  app.set("trust proxy", apiEnvironment.TRUST_PROXY_HOPS);
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
  const calendarStore = providedCalendarStore ?? new PrismaGoogleCalendarConnectionStore(prisma, apiEnvironment.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY);
  const calendarOAuthClient = providedCalendarOAuthClient ?? createGoogleCalendarOAuthClient({
    clientId: apiEnvironment.GOOGLE_CALENDAR_OAUTH_CLIENT_ID,
    clientSecret: apiEnvironment.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET
  });
  const calendarEventCreationEnabled = providedCalendarEventCreationEnabled ?? apiEnvironment.GOOGLE_CALENDAR_EVENTS_ENABLED;
  const calendarRuntime = new CalendarActionRuntime({
    enabled: calendarEventCreationEnabled,
    connectionStore: calendarStore,
    oauthClient: calendarOAuthClient,
    calendarApi: providedCalendarEventApi ?? new GoogleCalendarApi()
  });
  const gmailSyncService = providedGmailSyncService ?? createGmailSyncService(logger);
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
  const actionProposalService = providedActionProposalService ?? new ActionProposalService(
    new PrismaActionProposalStore(prisma),
    () => new Date(),
    calendarRuntime,
    calendarRuntime
  );
  const taskManagementService = providedTaskManagementService ?? new TaskManagementService(
    new PrismaTaskManagementStore(prisma)
  );
  const memoryManagementService = providedMemoryManagementService ?? new MemoryManagementService(prisma);
  const followUpService = providedFollowUpService ?? new FollowUpService(prisma);
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
  if (rateLimitStore) {
    app.use(createRequestRateLimiter(rateLimitStore, {
      secureCookies: apiEnvironment.NODE_ENV === "production"
    }));
  }
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
      await checkBackgroundWorker?.();
      response.status(200).json(ServiceHealthSchema.parse({
        service: "api",
        status: "ok",
        requestId: response.locals.requestId
      }));
    } catch {
      logger.warn({ requestId: response.locals.requestId }, "health.dependency_unavailable");
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
  app.use("/v1/oauth", createGoogleCalendarCallbackRouter({
    store: calendarStore,
    authStore,
    oauthClient: calendarOAuthClient,
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
  app.use("/v1/calendar", createGoogleCalendarRouter({
    store: calendarStore,
    authStore,
    oauthClient: calendarOAuthClient,
    eventCreationEnabled: calendarEventCreationEnabled,
    logger
  }));
  app.use("/v1/syncs", createGmailSyncRouter({ service: gmailSyncService, authStore }));
  app.use("/v1/actions/proposals", createActionProposalRouter({
    service: actionProposalService,
    authStore
  }));
  app.use("/v1", createRequireAuthentication({
    store: authStore,
    secureCookies: apiEnvironment.NODE_ENV === "production",
    webOrigin: apiEnvironment.WEB_ORIGIN
  }));
  app.use("/v1/tasks", createTaskRouter({
    service: taskManagementService,
    webOrigin: apiEnvironment.WEB_ORIGIN,
    secureCookies: apiEnvironment.NODE_ENV === "production"
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
  app.use("/v1/memories", createMemoryRouter({
    service: memoryManagementService,
    webOrigin: apiEnvironment.WEB_ORIGIN,
    secureCookies: apiEnvironment.NODE_ENV === "production"
  }));
  app.use("/v1/follow-ups", createFollowUpRouter({
    service: followUpService,
    webOrigin: apiEnvironment.WEB_ORIGIN,
    secureCookies: apiEnvironment.NODE_ENV === "production"
  }));

  app.get("/v1", (_request, response) => {
    response.status(200).json({
      service: "api",
      status: "placeholder",
      capabilities: { gmail: true, emailAnalysis: true, replyDrafts: true, backgroundJobs: true }
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
