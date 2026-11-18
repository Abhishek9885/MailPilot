import { createServer, type Server } from "node:http";
import { apiEnvironment } from "./environment.js";
import { prisma, checkDatabase } from "./database.js";
import { logger } from "./logger.js";
import { createApp } from "./app.js";

const app = createApp({ checkDatabase });
const server: Server = createServer(app);

server.listen(apiEnvironment.API_PORT, "0.0.0.0", () => {
  logger.info({ port: apiEnvironment.API_PORT }, "server.started");
});

let isShuttingDown = false;

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ reason }, "server.shutdown.started");

  const forceExit = setTimeout(() => {
    logger.error({ reason }, "server.shutdown.timeout");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  await new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });

  await prisma.$disconnect();
  clearTimeout(forceExit);
  logger.info({ reason }, "server.shutdown.completed");
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  logger.fatal({ errorType: error.name }, "process.uncaught_exception");
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  logger.fatal({ reasonType: reason instanceof Error ? reason.name : typeof reason }, "process.unhandled_rejection");
  void shutdown("unhandledRejection", 1);
});
