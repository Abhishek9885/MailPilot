import { Router } from "express";
import { ApiError } from "../errors.js";
import { EmailQueryService } from "./email-query.js";

export function createEmailRouter(service: EmailQueryService): Router {
  const router = Router();

  router.get("/", async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const emails = await service.list(authContext.userId, request.query.limit);
      response.status(200).json(emails);
    } catch (error: unknown) {
      next(error);
    }
  });

  return router;
}
