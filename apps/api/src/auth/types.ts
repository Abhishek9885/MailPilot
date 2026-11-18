export interface GoogleIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  hostedDomain?: string;
}

export interface OAuthTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  issuedAt: number;
  returnTo: string;
}

export interface OAuthChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface GoogleOidcClient {
  buildAuthorizationUrl(input: OAuthChecks & { redirectUri: string; scope: string }): Promise<URL>;
  exchangeAuthorizationCode(callbackUrl: URL, checks: OAuthChecks): Promise<GoogleIdentity>;
}

export interface AuthenticatedUser {
  id: string;
  emailNormalized: string;
  status: "active" | "disabled";
}

export interface SessionRecord {
  id: string;
  userId: string;
  csrfTokenHash: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  user: Pick<AuthenticatedUser, "emailNormalized" | "status">;
}

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  csrfTokenHash: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface AuthStore {
  authenticateGoogleIdentity(identity: GoogleIdentity, authenticatedAt: Date): Promise<AuthenticatedUser>;
  createSession(input: CreateSessionInput): Promise<{ id: string }>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  revokeSession(sessionId: string, userId: string, revokedAt: Date): Promise<void>;
}

export interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  csrfTokenHash: string | null;
}

export class AuthenticationRejectedError extends Error {
  public constructor() {
    super("Authentication was rejected.");
    this.name = "AuthenticationRejectedError";
  }
}
