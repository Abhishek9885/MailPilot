import { Router } from "express";
import { createRequireCsrf } from "../auth/middleware.js";
import { apiEnvironment } from "../environment.js";
import { ApiError } from "../errors.js";
import { ReplyDraftService } from "./reply-draft-service.js";

export interface ReplyDraftRouterOptions {
  service: ReplyDraftService;
  webOrigin?: string;
  secureCookies?: boolean;
}

export function createReplyDraftRouter(options: ReplyDraftRouterOptions): Router {
  const router = Router();
  const webOrigin = options.webOrigin ?? apiEnvironment.WEB_ORIGIN;
  const secureCookies = options.secureCookies ?? apiEnvironment.NODE_ENV === "production";
  const requireCsrf = createRequireCsrf(webOrigin, secureCookies);

  router.get("/:emailId/reply-drafts", async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const emailId = typeof request.params.emailId === "string" ? request.params.emailId : "";
      const suggestions = await options.service.list(authContext.userId, emailId);
      response.status(200).json({ suggestions });
    } catch (error: unknown) {
      next(error);
    }
  });

  router.post("/:emailId/reply-drafts", requireCsrf, async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const emailId = typeof request.params.emailId === "string" ? request.params.emailId : "";
      const result = await options.service.generate(authContext.userId, emailId, request.body);
      response.status(200).json(result);
    } catch (error: unknown) {
      next(error);
    }
  });

  router.patch("/:emailId/reply-drafts/:draftId", requireCsrf, async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const emailId = typeof request.params.emailId === "string" ? request.params.emailId : "";
      const draftId = typeof request.params.draftId === "string" ? request.params.draftId : "";
      const suggestion = await options.service.edit(authContext.userId, emailId, draftId, request.body);
      response.status(200).json({ suggestion });
    } catch (error: unknown) {
      next(error);
    }
  });

  return router;
}
