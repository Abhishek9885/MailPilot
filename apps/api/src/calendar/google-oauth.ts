import * as oidc from "openid-client";
import { z } from "zod";

const GOOGLE_ISSUER = new URL("https://accounts.google.com");
const REQUIRED_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";
const GoogleClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.boolean()
}).strict();

export interface GoogleCalendarOAuthChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface GoogleCalendarTokenExchange {
  subject: string;
  email: string;
  emailVerified: boolean;
  refreshToken: string | undefined;
  grantedScopes: string[];
}

export interface GoogleCalendarOAuthClient {
  buildAuthorizationUrl(input: GoogleCalendarOAuthChecks & { redirectUri: string }): Promise<URL>;
  exchangeAuthorizationCode(callbackUrl: URL, checks: GoogleCalendarOAuthChecks): Promise<GoogleCalendarTokenExchange>;
  refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresInSeconds: number }>;
  revokeToken(token: string): Promise<void>;
}

export class GoogleCalendarOAuthUnavailableError extends Error {
  public constructor() {
    super("Google Calendar OAuth is not configured.");
    this.name = "GoogleCalendarOAuthUnavailableError";
  }
}

export class GoogleCalendarReauthRequiredError extends Error {
  public constructor() {
    super("Google Calendar authorization must be renewed.");
    this.name = "GoogleCalendarReauthRequiredError";
  }
}

export function createGoogleCalendarOAuthClient(configuration: { clientId: string; clientSecret: string }): GoogleCalendarOAuthClient {
  let discoveryPromise: Promise<oidc.Configuration> | undefined;
  const getConfiguration = (): Promise<oidc.Configuration> => {
    if (configuration.clientId.startsWith("local-") || configuration.clientSecret.startsWith("local-")) {
      throw new GoogleCalendarOAuthUnavailableError();
    }
    if (!discoveryPromise) {
      discoveryPromise = oidc.discovery(
        GOOGLE_ISSUER,
        configuration.clientId,
        { client_secret: configuration.clientSecret },
        undefined,
        { timeout: 10 }
      ).catch((error: unknown) => {
        discoveryPromise = undefined;
        throw error;
      });
    }
    return discoveryPromise;
  };

  return {
    async buildAuthorizationUrl(input): Promise<URL> {
      const config = await getConfiguration();
      return oidc.buildAuthorizationUrl(config, {
        redirect_uri: input.redirectUri,
        response_type: "code",
        scope: `openid email ${REQUIRED_CALENDAR_SCOPE}`,
        state: input.state,
        nonce: input.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(input.codeVerifier),
        code_challenge_method: "S256",
        prompt: "consent",
        access_type: "offline"
      });
    },

    async exchangeAuthorizationCode(callbackUrl, checks): Promise<GoogleCalendarTokenExchange> {
      const config = await getConfiguration();
      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        pkceCodeVerifier: checks.codeVerifier,
        idTokenExpected: true
      });
      const claims = GoogleClaimsSchema.safeParse(tokens.claims());
      if (!claims.success || !claims.data.email_verified) throw new Error("Google identity claims were invalid.");
      return {
        subject: claims.data.sub,
        email: claims.data.email.trim().toLowerCase(),
        emailVerified: claims.data.email_verified,
        refreshToken: tokens.refresh_token,
        grantedScopes: tokens.scope?.split(" ").filter(Boolean) ?? []
      };
    },

    async refreshAccessToken(refreshToken) {
      const config = await getConfiguration();
      try {
        const tokens = await oidc.refreshTokenGrant(config, refreshToken);
        if (!tokens.access_token) throw new GoogleCalendarReauthRequiredError();
        return { accessToken: tokens.access_token, expiresInSeconds: tokens.expires_in ?? 3600 };
      } catch (error: unknown) {
        if (error instanceof oidc.ResponseBodyError && ["invalid_grant", "unauthorized_client"].includes(error.error ?? "")) {
          throw new GoogleCalendarReauthRequiredError();
        }
        throw error;
      }
    },

    async revokeToken(token): Promise<void> {
      try {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }).toString(),
          signal: AbortSignal.timeout(10_000)
        });
      } catch {
        // Local credentials are still removed when Google revocation is unavailable.
      }
    }
  };
}
