import { Router } from "express";
import {
  FollowUpManagementResponseSchema,
  FollowUpSettingsResponseSchema,
  FollowUpStatusResponseSchema
} from "@mailpilot/shared";
import { createRequireCsrf } from "../auth/middleware.js";
import { apiEnvironment } from "../environment.js";
import { ApiError } from "../errors.js";
import { FollowUpService } from "./service.js";

export interface FollowUpRouterOptions {
  service: FollowUpService;
  webOrigin?: string;
  secureCookies?: boolean;
}

export function createFollowUpRouter(options: FollowUpRouterOptions): Router {
  const router = Router();
  const requireCsrf = createRequireCsrf(
    options.webOrigin ?? apiEnvironment.WEB_ORIGIN,
    options.secureCookies ?? apiEnvironment.NODE_ENV === "production"
  );

  router.get("/", async (request, response, next) => {
    try {
      const auth = request.authContext;
      if (!auth) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      response.status(200).json(FollowUpManagementResponseSchema.parse(await options.service.list(auth.userId)));
    } catch (error: unknown) { next(error); }
  });

  router.patch("/settings", requireCsrf, async (request, response, next) => {
    try {
      const auth = request.authContext;
      if (!auth) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      response.status(200).json(FollowUpSettingsResponseSchema.parse(await options.service.updateSettings(auth.userId, request.body)));
    } catch (error: unknown) { next(error); }
  });

  router.patch("/:followUpId", requireCsrf, async (request, response, next) => {
    try {
      const auth = request.authContext;
      if (!auth) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const id = typeof request.params.followUpId === "string" ? request.params.followUpId : "";
      response.status(200).json(FollowUpStatusResponseSchema.parse(await options.service.update(auth.userId, id, request.body)));
    } catch (error: unknown) { next(error); }
  });

  return router;
}
