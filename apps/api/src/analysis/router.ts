import { Router } from "express";
import { createRequireCsrf } from "../auth/middleware.js";
import { apiEnvironment } from "../environment.js";
import { ApiError } from "../errors.js";
import { EmailAnalysisService } from "./email-analysis-service.js";
import { z } from "zod";

const AnalyzeRequestSchema = z.object({ reanalyze: z.boolean().optional() });

export interface EmailAnalysisRouterOptions {
  service: EmailAnalysisService;
  webOrigin?: string;
  secureCookies?: boolean;
}

export function createEmailAnalysisRouter(options: EmailAnalysisRouterOptions): Router {
  const router = Router();
  const webOrigin = options.webOrigin ?? apiEnvironment.WEB_ORIGIN;
  const secureCookies = options.secureCookies ?? apiEnvironment.NODE_ENV === "production";
  const requireCsrf = createRequireCsrf(webOrigin, secureCookies);

  router.get("/:emailId/analysis", async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const emailId = typeof request.params.emailId === "string" ? request.params.emailId : "";
      const analysis = await options.service.get(authContext.userId, emailId);
      response.status(200).json({ analysis });
    } catch (error: unknown) {
      next(error);
    }
  });

  router.post("/:emailId/analysis", requireCsrf, async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const emailId = typeof request.params.emailId === "string" ? request.params.emailId : "";
      const requestOptions = AnalyzeRequestSchema.safeParse(request.body ?? {});
      if (!requestOptions.success) throw new ApiError(400, "INVALID_ARGUMENT", "Analysis request is invalid");
      const analysis = await options.service.analyze(
        authContext.userId,
        emailId,
        { reanalyze: requestOptions.data.reanalyze ?? false },
        typeof response.locals.requestId === "string" ? response.locals.requestId : undefined
      );
      response.status(200).json({ analysis });
    } catch (error: unknown) {
      next(error);
    }
  });

  return router;
}
