export interface GmailOAuthTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  issuedAt: number;
  sessionId: string;
  userId: string;
  returnTo: string;
}

export interface GmailOAuthChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface GmailOAuthClient {
  buildAuthorizationUrl(input: GmailOAuthChecks & { redirectUri: string; scope: string }): Promise<URL>;
  exchangeAuthorizationCode(callbackUrl: URL, checks: GmailOAuthChecks): Promise<GmailTokenExchange>;
  refreshAccessToken(refreshToken: string): Promise<RefreshedAccessToken>;
  revokeToken(token: string): Promise<void>;
}

export interface RefreshedAccessToken {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken?: string | undefined;
  grantedScopes?: string[] | undefined;
}

export interface GmailTokenExchange {
  subject: string;
  email: string;
  emailVerified: boolean;
  refreshToken: string | undefined;
  grantedScopes: string[];
}

export interface EncryptedToken {
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: string;
}

export interface ConnectGmailInput {
  userId: string;
  subject: string;
  email: string;
  refreshToken: string | undefined;
  grantedScopes: string[];
  connectedAt: Date;
}

export interface GmailConnectionRecord {
  id: string;
  userId: string;
  providerSubject: string;
  providerEmailNormalized: string;
  status: "active" | "reauth_required" | "disconnected";
  grantedScopes: string[];
  connectedAt: Date;
  disconnectedAt: Date | null;
  lastSuccessfulSyncAt: Date | null;
}

export interface GmailConnectionStore {
  connectGmail(input: ConnectGmailInput): Promise<GmailConnectionRecord>;
  getConnection(userId: string): Promise<GmailConnectionRecord | null>;
  getDecryptedRefreshToken(userId: string): Promise<string | null>;
  markReauthRequired(userId: string): Promise<void>;
  disconnectGmail(userId: string, disconnectedAt: Date): Promise<void>;
}

