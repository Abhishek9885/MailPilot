import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import type { Logger } from "pino";
import { Redis } from "ioredis";
import { getAuthCookieNames, hashSecret, readCookie } from "../auth/cookies.js";
import { apiEnvironment } from "../environment.js";
import { ApiError } from "../errors.js";
import { logger as defaultLogger } from "../logger.js";

const GLOBAL_LIMIT = { name: "global", limit: 300, windowMs: 5 * 60_000 } as const;
const ROUTE_LIMITS = {
  oauth: { name: "oauth", limit: 20, windowMs: 10 * 60_000 },
  ai: { name: "ai", limit: 10, windowMs: 60_000 },
  sync: { name: "sync", limit: 3, windowMs: 10 * 60_000 },
  action: { name: "action", limit: 12, windowMs: 60_000 }
} as const;

const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { count, redis.call('PTTL', KEYS[1]) }
`;

export interface RateLimitIncrement {
  count: number;
  ttlMs: number;
}

export interface RateLimitStore {
  increment(key: string, ttlMs: number): Promise<RateLimitIncrement>;
}

export interface RedisRateLimitRuntime {
  store: RateLimitStore;
  close(): Promise<void>;
}

export function createRedisRateLimitRuntime(
  redisUrl: string = apiEnvironment.REDIS_URL,
  logger: Logger = defaultLogger
): RedisRateLimitRuntime {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 1_500,
    commandTimeout: 1_500
  });
  redis.on("error", (error: unknown) => {
    logger.warn(
      { errorType: error instanceof Error ? error.name : "RedisError" },
      "security.rate_limit_store_error"
    );
  });

  return {
    store: {
      async increment(key, ttlMs) {
        const result: unknown = await redis.eval(INCREMENT_SCRIPT, 1, key, ttlMs);
        if (
          !Array.isArray(result) ||
          result.length !== 2 ||
          typeof result[0] !== "number" ||
          typeof result[1] !== "number" ||
          result[0] < 1 ||
          result[1] < 0
        ) {
          throw new Error("Rate-limit storage returned an invalid counter result");
        }
        return { count: result[0], ttlMs: result[1] };
      }
    },
    async close() {
      if (redis.status === "end") return;
      if (redis.status === "wait") {
        redis.disconnect();
        return;
      }
      await redis.quit();
    }
  };
}

export function createRequestRateLimiter(
  store: RateLimitStore,
  options: { secureCookies?: boolean; now?: () => number } = {}
): RequestHandler {
  const secureCookies = options.secureCookies ?? apiEnvironment.NODE_ENV === "production";
  const now = options.now ?? Date.now;

  return async (request, _response, next) => {
    if (request.method === "OPTIONS" || request.path.startsWith("/health/")) {
      next();
      return;
    }

    const time = now();
    const clientAddress = request.ip || request.socket.remoteAddress || "unknown";
    const sessionToken = readCookie(
      request.headers.cookie,
      getAuthCookieNames(secureCookies).session
    );
    const sessionSubject = sessionToken && /^[A-Za-z0-9_-]{43}$/.test(sessionToken)
      ? hashSecret(sessionToken)
      : null;
    const rule = routeLimit(request.method, request.path);
    const checks = [
      { subject: `ip:${clientAddress}`, rule: GLOBAL_LIMIT },
      ...(rule ? [{ subject: `ip:${clientAddress}`, rule }] : []),
      ...(rule && sessionSubject
        ? [{ subject: `session:${sessionSubject}`, rule }]
        : [])
    ];

    try {
      for (const check of checks) {
        const bucket = Math.floor(time / check.rule.windowMs);
        const digest = createHash("sha256")
          .update(`${check.subject}:${check.rule.name}:${bucket}`)
          .digest("hex");
        const result = await store.increment(
          `mailpilot:rate:v1:${digest}`,
          check.rule.windowMs * 2
        );
        if (result.count > check.rule.limit) {
          const retryAfterSeconds = Math.max(1, Math.ceil(result.ttlMs / 1_000));
          next(new ApiError(
            429,
            "RATE_LIMITED",
            "Too many requests. Please retry later.",
            true,
            retryAfterSeconds
          ));
          return;
        }
      }
    } catch {
      next(new ApiError(
        503,
        "RATE_LIMITER_UNAVAILABLE",
        "Requests are temporarily unavailable",
        true,
        1
      ));
      return;
    }

    next();
  };
}

function routeLimit(method: string, path: string): (typeof ROUTE_LIMITS)[keyof typeof ROUTE_LIMITS] | null {
  if (
    /^\/v1\/auth\/google\/(?:start|callback)$/.test(path) ||
    /^\/v1\/oauth\/google(?:-calendar)?\/callback$/.test(path) ||
    (method === "GET" && /^\/v1\/(?:gmail|calendar)\/connect$/.test(path))
  ) {
    return ROUTE_LIMITS.oauth;
  }
  if (
    (method === "POST" && /^\/v1\/emails\/[^/]+\/(?:analysis|reply-drafts)$/.test(path))
  ) {
    return ROUTE_LIMITS.ai;
  }
  if (method === "POST" && /^\/v1\/syncs\/?$/.test(path)) return ROUTE_LIMITS.sync;
  if (path.startsWith("/v1/actions/proposals")) return ROUTE_LIMITS.action;
  return null;
}
