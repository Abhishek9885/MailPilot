import { Router } from "express";
import { createRequireCsrf } from "../auth/middleware.js";
import { apiEnvironment } from "../environment.js";
import { ApiError } from "../errors.js";
import { TaskListResponseSchema, TaskReadResponseSchema } from "@mailpilot/shared";
import { TaskManagementService } from "./task-management-service.js";

export interface TaskRouterOptions {
  service: TaskManagementService;
  webOrigin?: string;
  secureCookies?: boolean;
}

export function createTaskRouter(options: TaskRouterOptions): Router {
  const router = Router();
  const webOrigin = options.webOrigin ?? apiEnvironment.WEB_ORIGIN;
  const secureCookies = options.secureCookies ?? apiEnvironment.NODE_ENV === "production";
  const requireCsrf = createRequireCsrf(webOrigin, secureCookies);

  router.get("/", async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const tasks = await options.service.list(authContext.userId, request.query.status);
      response.status(200).json(TaskListResponseSchema.parse(tasks));
    } catch (error: unknown) {
      next(error);
    }
  });

  router.patch("/:taskId", requireCsrf, async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const taskId = typeof request.params.taskId === "string" ? request.params.taskId : "";
      const task = await options.service.update(authContext.userId, taskId, request.body);
      response.status(200).json(TaskReadResponseSchema.parse({ task }));
    } catch (error: unknown) {
      next(error);
    }
  });

  return router;
}
