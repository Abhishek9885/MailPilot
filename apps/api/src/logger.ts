import pino from "pino";
import { apiEnvironment } from "./environment.js";

export const logger = pino({
  name: "mailpilot-api",
  level: apiEnvironment.API_LOG_LEVEL,
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "*.token", "*.refreshToken", "*.body"],
    censor: "[REDACTED]"
  },
  base: { service: "api" },
  timestamp: pino.stdTimeFunctions.isoTime
});
