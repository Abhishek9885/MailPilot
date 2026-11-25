import pino, { type DestinationStream } from "pino";
import { apiEnvironment } from "./environment.js";

const redactedPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-service-signature"]',
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.clientSecret",
  "*.apiKey",
  "*.password",
  "*.secret",
  "*.body",
  "*.bodyText",
  "*.bodyHtml",
  "*.subject",
  "*.senderEmail",
  "*.senderName",
  "*.userEmail",
  "*.recipient",
  "*.recipientEmail",
  "*.email",
  "*.query",
  "*.prompt",
  "*.content",
  "*.evidence",
  "*.messages",
  "*.from",
  "*.to",
  "*.cc",
  "*.bcc",
  "*.headers",
  "*.attachments",
  "*.filename",
  "*.payload",
  "*.response",
  "*.output",
  "*.draft"
];

export function createApiLogger(
  destination?: DestinationStream,
  level: string = apiEnvironment.API_LOG_LEVEL
) {
  const options = {
    name: "mailpilot-api",
    level,
    redact: { paths: redactedPaths, censor: "[REDACTED]" },
    base: { service: "api" },
    timestamp: pino.stdTimeFunctions.isoTime
  };

  return destination ? pino(options, destination) : pino(options);
}

export const logger = createApiLogger();
