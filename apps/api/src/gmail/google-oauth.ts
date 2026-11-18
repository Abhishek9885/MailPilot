import * as oidc from "openid-client";
import { z } from "zod";
import { GmailReauthRequiredError } from "./api-errors.js";
import type { GmailOAuthChecks, GmailOAuthClient, GmailTokenExchange, RefreshedAccessToken } from "./types.js";

const GOOGLE_ISSUER = new URL("https://accounts.google.com");
const GoogleClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.boolean()
});

export interface GoogleGmailOAuthConfiguration {
  clientId: string;
  clientSecret: string;
}

export class GoogleGmailOAuthUnavailableError extends Error {
  public constructor() {
    super("Google Gmail OAuth is not configured.");
    this.name = "GoogleGmailOAuthUnavailableError";
  }
}

export function createGoogleGmailOAuthClient(configuration: GoogleGmailOAuthConfiguration): GmailOAuthClient {
  let discoveryPromise: Promise<oidc.Configuration> | undefined;

  const getConfiguration = (): Promise<oidc.Configuration> => {
    if (configuration.clientId.startsWith("local-") || configuration.clientSecret.startsWith("local-")) {
      throw new GoogleGmailOAuthUnavailableError();
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
    async buildAuthorizationUrl(input: GmailOAuthChecks & { redirectUri: string; scope: string }): Promise<URL> {
      const config = await getConfiguration();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(input.codeVerifier);
      return oidc.buildAuthorizationUrl(config, {
        redirect_uri: input.redirectUri,
        response_type: "code",
        scope: input.scope,
        state: input.state,
        nonce: input.nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        prompt: "consent",
        access_type: "offline"
      });
    },

    async exchangeAuthorizationCode(callbackUrl: URL, checks: GmailOAuthChecks): Promise<GmailTokenExchange> {
      const config = await getConfiguration();
      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        pkceCodeVerifier: checks.codeVerifier,
        idTokenExpected: true
      });
      const claims = GoogleClaimsSchema.safeParse(tokens.claims());
      if (!claims.success) throw new Error("Google identity claims were invalid.");

      const grantedScopes = tokens.scope ? tokens.scope.split(" ").filter(Boolean) : [];

      return {
        subject: claims.data.sub,
        email: claims.data.email.trim().toLowerCase(),
        emailVerified: claims.data.email_verified,
        refreshToken: tokens.refresh_token,
        grantedScopes
      };
    },

    async refreshAccessToken(refreshToken: string): Promise<RefreshedAccessToken> {
      const config = await getConfiguration();
      try {
        const tokens = await oidc.refreshTokenGrant(config, refreshToken);
        const accessToken = tokens.access_token;
        if (!accessToken) {
          throw new GmailReauthRequiredError("Failed to obtain access token from Google.");
        }
        const grantedScopes = tokens.scope ? tokens.scope.split(" ").filter(Boolean) : undefined;
        return {
          accessToken,
          expiresInSeconds: tokens.expires_in ?? 3600,
          refreshToken: tokens.refresh_token,
          grantedScopes
        };
      } catch (error: unknown) {
        if (
          error instanceof oidc.ResponseBodyError &&
          (error.error === "invalid_grant" || error.error === "unauthorized_client")
        ) {
          throw new GmailReauthRequiredError("Google refresh token is invalid or has been revoked.");
        }
        if (typeof error === "object" && error !== null && "error" in error && error.error === "invalid_grant") {
          throw new GmailReauthRequiredError("Google refresh token is invalid or has been revoked.");
        }
        throw error;
      }
    },

    async revokeToken(token: string): Promise<void> {
      try {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: new URLSearchParams({ token }).toString()
        });
      } catch {
        // Best effort revocation; failure to reach Google does not block local disconnection
      }
    }
  };
}

