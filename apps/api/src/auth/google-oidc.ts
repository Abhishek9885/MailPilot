import * as oidc from "openid-client";
import { z } from "zod";
import type { GoogleOidcClient, OAuthChecks } from "./types.js";

const GOOGLE_ISSUER = new URL("https://accounts.google.com");
const GoogleClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.email(),
  email_verified: z.boolean(),
  hd: z.string().min(1).optional()
});

export interface GoogleOidcConfiguration {
  clientId: string;
  clientSecret: string;
}

export function createGoogleOidcClient(configuration: GoogleOidcConfiguration): GoogleOidcClient {
  let discoveryPromise: Promise<oidc.Configuration> | undefined;

  const getConfiguration = (): Promise<oidc.Configuration> => {
    if (configuration.clientId.startsWith("local-") || configuration.clientSecret.startsWith("local-")) {
      throw new GoogleOidcUnavailableError();
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
    async buildAuthorizationUrl(input: OAuthChecks & { redirectUri: string; scope: string }): Promise<URL> {
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
        prompt: "select_account"
      });
    },

    async exchangeAuthorizationCode(callbackUrl: URL, checks: OAuthChecks) {
      const config = await getConfiguration();
      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        pkceCodeVerifier: checks.codeVerifier,
        idTokenExpected: true
      });
      const claims = GoogleClaimsSchema.safeParse(tokens.claims());
      if (!claims.success) throw new Error("Google identity claims were invalid.");

      return {
        subject: claims.data.sub,
        email: claims.data.email.trim().toLowerCase(),
        emailVerified: claims.data.email_verified,
        ...(claims.data.hd ? { hostedDomain: claims.data.hd } : {})
      };
    }
  };
}

export class GoogleOidcUnavailableError extends Error {
  public constructor() {
    super("Google sign-in is not configured.");
    this.name = "GoogleOidcUnavailableError";
  }
}
