import { ActionProposalListResponseSchema, ActionProposalResponseSchema } from "@mailpilot/shared";
import { Router } from "express";
import type { AuthStore } from "../auth/types.js";
import { createRequireAuthentication, createRequireCsrf } from "../auth/middleware.js";
import { apiEnvironment } from "../environment.js";
import { ApiError } from "../errors.js";
import { ActionProposalService } from "./proposal-service.js";

export interface ActionProposalRouterOptions {
  service: ActionProposalService;
  authStore: AuthStore;
  webOrigin?: string;
  secureCookies?: boolean;
}

export function createActionProposalRouter(options: ActionProposalRouterOptions): Router {
  const router = Router();
  const webOrigin = options.webOrigin ?? apiEnvironment.WEB_ORIGIN;
  const secureCookies = options.secureCookies ?? apiEnvironment.NODE_ENV === "production";
  const requireAuthentication = createRequireAuthentication({
    store: options.authStore,
    secureCookies,
    webOrigin
  });
  const requireCsrf = createRequireCsrf(webOrigin, secureCookies);

  router.get("/", requireAuthentication, async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const proposals = await options.service.list(authContext.userId, getRequestId(response.locals.requestId));
      response.status(200).json(ActionProposalListResponseSchema.parse({ proposals }));
    } catch (error: unknown) {
      next(error);
    }
  });

  router.post("/", requireAuthentication, requireCsrf, async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const proposal = await options.service.create(authContext.userId, request.body, getRequestId(response.locals.requestId));
      response.status(201).json(ActionProposalResponseSchema.parse({ proposal }));
    } catch (error: unknown) {
      next(error);
    }
  });

  router.post("/:proposalId/approve", requireAuthentication, requireCsrf, async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const proposalId = typeof request.params.proposalId === "string" ? request.params.proposalId : "";
      const proposal = await options.service.approve(
        authContext.userId,
        proposalId,
        request.body,
        getRequestId(response.locals.requestId)
      );
      response.status(200).json(ActionProposalResponseSchema.parse({ proposal }));
    } catch (error: unknown) {
      next(error);
    }
  });

  router.post("/:proposalId/reject", requireAuthentication, requireCsrf, async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const proposalId = typeof request.params.proposalId === "string" ? request.params.proposalId : "";
      const proposal = await options.service.reject(
        authContext.userId,
        proposalId,
        request.body,
        getRequestId(response.locals.requestId)
      );
      response.status(200).json(ActionProposalResponseSchema.parse({ proposal }));
    } catch (error: unknown) {
      next(error);
    }
  });

  router.post("/:proposalId/execute", requireAuthentication, requireCsrf, async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const proposalId = typeof request.params.proposalId === "string" ? request.params.proposalId : "";
      const proposal = await options.service.executeApproved(
        authContext.userId,
        proposalId,
        request.body,
        getRequestId(response.locals.requestId)
      );
      response.status(200).json(ActionProposalResponseSchema.parse({ proposal }));
    } catch (error: unknown) {
      next(error);
    }
  });

  router.post("/:proposalId/reconcile", requireAuthentication, requireCsrf, async (request, response, next) => {
    try {
      const authContext = request.authContext;
      if (!authContext) throw new ApiError(401, "UNAUTHORIZED", "Sign-in is required");
      const proposalId = typeof request.params.proposalId === "string" ? request.params.proposalId : "";
      const proposal = await options.service.reconcile(
        authContext.userId,
        proposalId,
        request.body,
        getRequestId(response.locals.requestId)
      );
      response.status(200).json(ActionProposalResponseSchema.parse({ proposal }));
    } catch (error: unknown) {
      next(error);
    }
  });

  return router;
}

function getRequestId(value: unknown): string | null {
  return typeof value === "string" && value.length <= 128 ? value : null;
}
