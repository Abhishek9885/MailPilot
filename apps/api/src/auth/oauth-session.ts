import { getAuthCookieNames, hashSecret, readCookie } from "./cookies.js";
import type { AuthStore } from "./types.js";

export async function matchesCurrentOAuthSession(input: {
  authStore: AuthStore;
  cookieHeader: string | undefined;
  secureCookies: boolean;
  sessionId: string;
  userId: string;
  now: Date;
}): Promise<boolean> {
  const sessionToken = readCookie(
    input.cookieHeader,
    getAuthCookieNames(input.secureCookies).session
  );
  if (!sessionToken || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return false;

  const session = await input.authStore.findSessionByTokenHash(hashSecret(sessionToken));
  return Boolean(
    session &&
    session.id === input.sessionId &&
    session.userId === input.userId &&
    session.revokedAt === null &&
    session.expiresAt.getTime() > input.now.getTime() &&
    session.user.status === "active"
  );
}
