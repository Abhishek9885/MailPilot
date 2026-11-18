import { GmailReauthRequiredError } from "./api-errors.js";
import type { GmailConnectionStore, GmailOAuthClient } from "./types.js";

export interface GmailTokenProvider {
  getAccessToken(): Promise<string>;
  invalidateToken(): void;
}

export function createStaticTokenProvider(token: string): GmailTokenProvider {
  let activeToken: string | null = token;
  return {
    async getAccessToken(): Promise<string> {
      if (!activeToken) {
        throw new GmailReauthRequiredError("Static access token has been invalidated.");
      }
      return activeToken;
    },
    invalidateToken(): void {
      activeToken = null;
    }
  };
}

export interface RefreshingTokenProviderOptions {
  userId: string;
  connectionStore: GmailConnectionStore;
  oauthClient: GmailOAuthClient;
  clock?: () => number;
  bufferMs?: number;
}

export function createRefreshingTokenProvider(options: RefreshingTokenProviderOptions): GmailTokenProvider {
  const clock = options.clock ?? Date.now;
  const bufferMs = options.bufferMs ?? 60_000; // Refresh 60s before Google expires it

  let cachedToken: string | null = null;
  let expiresAt = 0;
  let inflightRefresh: Promise<string> | null = null;

  const performRefresh = async (): Promise<string> => {
    try {
      const refreshToken = await options.connectionStore.getDecryptedRefreshToken(options.userId);
      if (!refreshToken) {
        await options.connectionStore.markReauthRequired(options.userId);
        throw new GmailReauthRequiredError("No Gmail refresh token available for user.");
      }

      const refreshed = await options.oauthClient.refreshAccessToken(refreshToken);
      cachedToken = refreshed.accessToken;
      expiresAt = clock() + refreshed.expiresInSeconds * 1000;
      return cachedToken;
    } catch (error: unknown) {
      cachedToken = null;
      expiresAt = 0;
      if (error instanceof GmailReauthRequiredError) {
        await options.connectionStore.markReauthRequired(options.userId).catch(() => undefined);
      }
      throw error;
    } finally {
      inflightRefresh = null;
    }
  };

  return {
    async getAccessToken(): Promise<string> {
      const now = clock();
      if (cachedToken && now < expiresAt - bufferMs) {
        return cachedToken;
      }

      if (!inflightRefresh) {
        inflightRefresh = performRefresh();
      }

      return inflightRefresh;
    },

    invalidateToken(): void {
      cachedToken = null;
      expiresAt = 0;
    }
  };
}

