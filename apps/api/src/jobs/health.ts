import { Redis } from "ioredis";
import { WORKER_HEARTBEAT_PREFIX } from "./contracts.js";

export interface BackgroundHealthCheck {
  check(): Promise<void>;
  close(): Promise<void>;
}

export function createBackgroundHealthCheck(redisUrl: string): BackgroundHealthCheck {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false
  });
  redis.on("error", () => undefined);

  return {
    async check(): Promise<void> {
      await redis.ping();
      let cursor = "0";
      let foundWorker = false;
      do {
        const [nextCursor, keys] = await redis.scan(
          cursor,
          "MATCH",
          `${WORKER_HEARTBEAT_PREFIX}*`,
          "COUNT",
          100
        );
        if (keys.length > 0) foundWorker = true;
        cursor = nextCursor;
      } while (cursor !== "0" && !foundWorker);
      if (!foundWorker) throw new Error("Background worker is unavailable");
    },
    async close(): Promise<void> {
      if (redis.status === "end") return;
      if (redis.status === "wait") {
        redis.disconnect();
        return;
      }
      await redis.quit();
    }
  };
}
