import { Router } from "express";
import { z } from "zod";
import type { AuthStore } from "../auth/types.js";
import { createRequireAuthentication, createRequireCsrf } from "../auth/middleware.js";
import { apiEnvironment } from "../environment.js";
import { ApiError } from "../errors.js";
import { GmailSyncService } from "./sync-service.js";

const StartSyncBodySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("initial"),
    maxMessages: z.number().int().min(1).max(2_000).optional()
  }).strict(),
  z.object({ mode: z.literal("incremental") }).strict()
]);

const SyncIdSchema = z.string().uuid();

export interface GmailSyncRouterDependencies {
  service: GmailSyncService;
  authStore: AuthStore;
  webOrigin?: string;
  secureCookies?: boolean;
  now?: () => Date;
}

export function createGmailSyncRouter(dependencies: GmailSyncRouterDependencies): Router {
  const router = Router();
  const secureCookies = dependencies.secureCookies ?? apiEnvironment.NODE_ENV === "production";
  const requireAuthentication = createRequireAuthentication({
    store: dependencies.authStore,
    secureCookies,
    webOrigin: dependencies.webOrigin ?? apiEnvironment.WEB_ORIGIN,
    ...(dependencies.now ? { now: dependencies.now } : {})
  });
  const requireCsrf = createRequireCsrf(
    dependencies.webOrigin ?? apiEnvironment.WEB_ORIGIN,
    secureCookies
  );

  router.post("/", requireAuthentication, requireCsrf, async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const body = StartSyncBodySchema.safeParse(request.body);
      if (!body.success) throw new ApiError(400, "INVALID_ARGUMENT", "Invalid Gmail sync request");

      const sync = await dependencies.service.start(
        authContext.userId,
        body.data.mode,
        body.data.mode === "initial" ? body.data.maxMessages : undefined
      );
      response.status(202).json({ sync });
    } catch (error: unknown) {
      next(error);
    }
  });

  router.get("/:syncId", requireAuthentication, async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const syncId = parseSyncId(request.params.syncId);
      const sync = await dependencies.service.getProgress(authContext.userId, syncId);
      response.status(200).json({ sync });
    } catch (error: unknown) {
      next(error);
    }
  });

  router.post("/:syncId/step", requireAuthentication, requireCsrf, async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const syncId = parseSyncId(request.params.syncId);
      const sync = await dependencies.service.processNextBatch(authContext.userId, syncId);
      response.status(200).json({ sync });
    } catch (error: unknown) {
      next(error);
    }
  });

  router.delete("/:syncId", requireAuthentication, requireCsrf, async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const syncId = parseSyncId(request.params.syncId);
      const sync = await dependencies.service.cancel(authContext.userId, syncId);
      response.status(200).json({ sync });
    } catch (error: unknown) {
      next(error);
    }
  });

  return router;
}

function parseSyncId(value: string | string[] | undefined): string {
  const parsed = SyncIdSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(404, "SYNC_NOT_FOUND", "Gmail sync was not found");
  return parsed.data;
}
