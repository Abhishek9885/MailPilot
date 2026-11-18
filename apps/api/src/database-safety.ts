const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOCAL_POSTGRES_PORT = "55432";

function parseDatabaseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error("Database URL is invalid.");
  }
}

function isLocalPostgres(url: URL): boolean {
  return (url.protocol === "postgresql:" || url.protocol === "postgres:")
    && LOCAL_DATABASE_HOSTS.has(url.hostname.toLowerCase())
    && url.port === LOCAL_POSTGRES_PORT;
}

export function assertSafeDevelopmentSeedTarget(databaseUrl: string, nodeEnvironment: string | undefined): void {
  const url = parseDatabaseUrl(databaseUrl);
  if (nodeEnvironment !== "development" || !isLocalPostgres(url) || url.pathname !== "/mailpilot") {
    throw new Error("Development seed requires NODE_ENV=development and the local mailpilot database on port 55432.");
  }
}

export function assertSafeIntegrationTestTarget(databaseUrl: string): void {
  const url = parseDatabaseUrl(databaseUrl);
  if (!isLocalPostgres(url) || url.pathname !== "/mailpilot_test") {
    throw new Error("Database integration tests require the local mailpilot_test database on port 55432.");
  }
}
