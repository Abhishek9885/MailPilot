import { z } from "zod";

const ApiEnvironmentBaseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  API_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  WEB_ORIGIN: z.url().default("http://localhost:3000"),
  API_PUBLIC_ORIGIN: z.url().default("http://localhost:4000"),
  AI_SERVICE_URL: z.url().default("http://localhost:8000"),
  REDIS_URL: z.url().refine((value) => value.startsWith("redis://") || value.startsWith("rediss://"), {
    message: "must be a Redis URL"
  }).default("redis://localhost:56379"),
  AI_SERVICE_TOKEN: z.string().min(32).default("local-development-ai-service-token-change-before-use"),
  AI_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(180_000).default(120_000),
  GOOGLE_OIDC_CLIENT_ID: z.string().min(1).default("local-google-client-id.apps.googleusercontent.com"),
  GOOGLE_OIDC_CLIENT_SECRET: z.string().min(1).default("local-development-only-google-client-secret"),
  GOOGLE_GMAIL_OAUTH_CLIENT_ID: z.string().min(1).default("local-gmail-oauth-client-id.apps.googleusercontent.com"),
  GOOGLE_GMAIL_OAUTH_CLIENT_SECRET: z.string().min(1).default("local-development-only-gmail-oauth-client-secret"),
  GOOGLE_CALENDAR_OAUTH_CLIENT_ID: z.string().min(1).default("local-calendar-oauth-client-id.apps.googleusercontent.com"),
  GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: z.string().min(1).default("local-development-only-calendar-oauth-client-secret"),
  GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: z.string().min(1).default("local-replace-with-base64-encoded-32-byte-key"),
  GOOGLE_CALENDAR_EVENTS_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  GMAIL_TOKEN_ENCRYPTION_KEY: z.string().min(1).default("local-replace-with-base64-encoded-32-byte-key"),
  SESSION_SECRET: z.string().min(32).default("local-development-session-secret-change-before-use"),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(604800).default(28800),
  DATABASE_URL: z.url().refine((value) => value.startsWith("postgresql://") || value.startsWith("postgres://"), {
    message: "must be a PostgreSQL connection URL"
  })
});

export const ApiEnvironmentSchema = ApiEnvironmentBaseSchema.superRefine((environment, context) => {
  for (const [key, value] of [
    ["WEB_ORIGIN", environment.WEB_ORIGIN],
    ["API_PUBLIC_ORIGIN", environment.API_PUBLIC_ORIGIN],
    ["AI_SERVICE_URL", environment.AI_SERVICE_URL]
  ] as const) {
    const url = new URL(value);
    if (url.pathname !== "/" || url.search || url.hash) {
      context.addIssue({ code: "custom", path: [key], message: "must be an origin without a path" });
    }
  }

  if (environment.GOOGLE_CALENDAR_EVENTS_ENABLED) {
    if (environment.GOOGLE_CALENDAR_OAUTH_CLIENT_ID.startsWith("local-")) {
      context.addIssue({ code: "custom", path: ["GOOGLE_CALENDAR_OAUTH_CLIENT_ID"], message: "must be configured when calendar writes are enabled" });
    }
    if (environment.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET.startsWith("local-")) {
      context.addIssue({ code: "custom", path: ["GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET"], message: "must be configured when calendar writes are enabled" });
    }
  }

  if (environment.GOOGLE_CALENDAR_EVENTS_ENABLED || environment.NODE_ENV === "production") {
    const calendarEncryptionKey = Buffer.from(environment.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY, "base64");
    if (calendarEncryptionKey.length !== 32 || calendarEncryptionKey.toString("base64") !== environment.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY) {
      context.addIssue({ code: "custom", path: ["GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY"], message: "must be a base64-encoded 32-byte key when Calendar OAuth is enabled for production or event writes are enabled" });
    }
  }

  if (environment.NODE_ENV !== "production") return;

  if (environment.GOOGLE_OIDC_CLIENT_ID.startsWith("local-")) {
    context.addIssue({ code: "custom", path: ["GOOGLE_OIDC_CLIENT_ID"], message: "must be configured for production" });
  }
  if (environment.GOOGLE_OIDC_CLIENT_SECRET.startsWith("local-")) {
    context.addIssue({ code: "custom", path: ["GOOGLE_OIDC_CLIENT_SECRET"], message: "must be configured for production" });
  }
  if (environment.GOOGLE_GMAIL_OAUTH_CLIENT_ID.startsWith("local-")) {
    context.addIssue({ code: "custom", path: ["GOOGLE_GMAIL_OAUTH_CLIENT_ID"], message: "must be configured for production" });
  }
  if (environment.GOOGLE_GMAIL_OAUTH_CLIENT_SECRET.startsWith("local-")) {
    context.addIssue({ code: "custom", path: ["GOOGLE_GMAIL_OAUTH_CLIENT_SECRET"], message: "must be configured for production" });
  }
  if (environment.SESSION_SECRET.startsWith("local-")) {
    context.addIssue({ code: "custom", path: ["SESSION_SECRET"], message: "must be configured for production" });
  }
  if (environment.AI_SERVICE_TOKEN.startsWith("local-")) {
    context.addIssue({ code: "custom", path: ["AI_SERVICE_TOKEN"], message: "must be configured for production" });
  }
  if (environment.GMAIL_TOKEN_ENCRYPTION_KEY.startsWith("local-")) {
    context.addIssue({ code: "custom", path: ["GMAIL_TOKEN_ENCRYPTION_KEY"], message: "must be configured for production" });
  }
  const encryptionKey = Buffer.from(environment.GMAIL_TOKEN_ENCRYPTION_KEY, "base64");
  if (encryptionKey.length !== 32 || encryptionKey.toString("base64") !== environment.GMAIL_TOKEN_ENCRYPTION_KEY) {
    context.addIssue({ code: "custom", path: ["GMAIL_TOKEN_ENCRYPTION_KEY"], message: "must be a base64-encoded 32-byte key" });
  }

  const webUrl = new URL(environment.WEB_ORIGIN);
  const apiUrl = new URL(environment.API_PUBLIC_ORIGIN);
  if (webUrl.protocol !== "https:") {
    context.addIssue({ code: "custom", path: ["WEB_ORIGIN"], message: "production origins must use HTTPS" });
  }
  if (apiUrl.protocol !== "https:") {
    context.addIssue({ code: "custom", path: ["API_PUBLIC_ORIGIN"], message: "production origins must use HTTPS" });
  }
  if (new URL(environment.AI_SERVICE_URL).protocol !== "https:") {
    context.addIssue({ code: "custom", path: ["AI_SERVICE_URL"], message: "production origins must use HTTPS" });
  }
  if (new URL(environment.REDIS_URL).protocol !== "rediss:") {
    context.addIssue({ code: "custom", path: ["REDIS_URL"], message: "production Redis connections must use TLS" });
  }
  if (webUrl.hostname !== apiUrl.hostname) {
    context.addIssue({ code: "custom", path: ["API_PUBLIC_ORIGIN"], message: "must share the web host for the session cookie" });
  }
});

export type ApiEnvironment = z.infer<typeof ApiEnvironmentSchema>;

export function loadApiEnvironment(environment: Record<string, string | undefined>): ApiEnvironment {
  const result = ApiEnvironmentSchema.safeParse(environment);

  if (!result.success) {
    const variables = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))].join(", ");
    throw new Error(`Invalid API environment configuration: ${variables}`);
  }

  return result.data;
}

export const apiEnvironment = loadApiEnvironment(process.env);
