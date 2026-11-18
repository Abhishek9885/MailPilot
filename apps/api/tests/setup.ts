process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://mailpilot:local_dev_only@localhost:55432/mailpilot?schema=public";
process.env.API_PORT ??= "4000";
process.env.API_LOG_LEVEL ??= "silent";
process.env.WEB_ORIGIN ??= "http://localhost:3000";
