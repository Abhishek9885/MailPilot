import { Router, type Response } from "express";
import {
  MemoryItemResponseSchema,
  MemoryManagementResponseSchema,
  MemoryRetrievalResponseSchema,
  MemorySettingsResponseSchema
} from "@mailpilot/shared";
import { createRequireCsrf } from "../auth/middleware.js";
import { apiEnvironment } from "../environment.js";
import { ApiError } from "../errors.js";
import { MemoryManagementService } from "./memory-service.js";

export interface MemoryRouterOptions {
  service: MemoryManagementService;
  webOrigin?: string;
  secureCookies?: boolean;
}

export function createMemoryRouter(options: MemoryRouterOptions): Router {
  const router = Router();
  const requireCsrf = createRequireCsrf(
    options.webOrigin ?? apiEnvironment.WEB_ORIGIN,
    options.secureCookies ?? apiEnvironment.NODE_ENV === "production"
  );

  router.get("/settings", async (request, response, next) => {
    try {
      const auth = request.authContext;
      if (!auth) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      response.status(200).json(MemorySettingsResponseSchema.parse(await options.service.getSettings(auth.userId)));
    } catch (error: unknown) {
      next(error);
    }
  });

  router.patch("/settings", requireCsrf, async (request, response, next) => {
    try {
      const auth = request.authContext;
      if (!auth) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      response.status(200).json(MemorySettingsResponseSchema.parse(
        await options.service.updateSettings(auth.userId, request.body, requestId(response))
      ));
    } catch (error: unknown) {
      next(error);
    }
  });

  router.get("/", async (request, response, next) => {
    try {
      const auth = request.authContext;
      if (!auth) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      response.status(200).json(MemoryManagementResponseSchema.parse(
        await options.service.list(auth.userId, requestId(response))
      ));
    } catch (error: unknown) {
      next(error);
    }
  });

  router.post("/retrieve", requireCsrf, async (request, response, next) => {
    try {
      const auth = request.authContext;
      if (!auth) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      response.status(200).json(MemoryRetrievalResponseSchema.parse(
        await options.service.retrieve(auth.userId, request.body, requestId(response))
      ));
    } catch (error: unknown) {
      next(error);
    }
  });

  router.post("/", requireCsrf, async (request, response, next) => {
    try {
      const auth = request.authContext;
      if (!auth) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      response.status(201).json(MemoryItemResponseSchema.parse(
        await options.service.create(auth.userId, request.body, requestId(response))
      ));
    } catch (error: unknown) {
      next(error);
    }
  });

  router.patch("/:memoryId", requireCsrf, async (request, response, next) => {
    try {
      const auth = request.authContext;
      if (!auth) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const memoryId = typeof request.params.memoryId === "string" ? request.params.memoryId : "";
      response.status(200).json(MemoryItemResponseSchema.parse(
        await options.service.update(auth.userId, memoryId, request.body, requestId(response))
      ));
    } catch (error: unknown) {
      next(error);
    }
  });

  router.post("/:memoryId/confirm", requireCsrf, async (request, response, next) => {
    try {
      const auth = request.authContext;
      if (!auth) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const memoryId = typeof request.params.memoryId === "string" ? request.params.memoryId : "";
      response.status(200).json(MemoryItemResponseSchema.parse(
        await options.service.confirm(auth.userId, memoryId, requestId(response))
      ));
    } catch (error: unknown) {
      next(error);
    }
  });

  router.delete("/:memoryId", requireCsrf, async (request, response, next) => {
    try {
      const auth = request.authContext;
      if (!auth) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const memoryId = typeof request.params.memoryId === "string" ? request.params.memoryId : "";
      await options.service.delete(auth.userId, memoryId, requestId(response));
      response.status(204).end();
    } catch (error: unknown) {
      next(error);
    }
  });

  return router;
}

function requestId(response: Response): string | undefined {
  const value: unknown = response.locals.requestId;
  return typeof value === "string" ? value : undefined;
}
