export interface GoogleCalendarConnectionRecord {
  id: string;
  userId: string;
  providerSubject: string;
  email: string;
  status: "active" | "reauth_required" | "disconnected";
  grantedScopes: string[];
  connectedAt: Date;
  disconnectedAt: Date | null;
}

export interface ConnectGoogleCalendarInput {
  userId: string;
  subject: string;
  email: string;
  refreshToken: string | undefined;
  grantedScopes: string[];
  connectedAt: Date;
}

export interface GoogleCalendarConnectionStore {
  connectCalendar(input: ConnectGoogleCalendarInput): Promise<GoogleCalendarConnectionRecord>;
  getConnection(userId: string): Promise<GoogleCalendarConnectionRecord | null>;
  getDecryptedRefreshToken(userId: string): Promise<string | null>;
  markReauthRequired(userId: string): Promise<void>;
  disconnectCalendar(userId: string, disconnectedAt: Date): Promise<void>;
}
