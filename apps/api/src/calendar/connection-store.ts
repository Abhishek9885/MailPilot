import type { PrismaClient } from "../generated/prisma/client.js";
import { decryptRefreshToken, encryptRefreshToken } from "../gmail/token-encryption.js";
import type { ConnectGoogleCalendarInput, GoogleCalendarConnectionRecord, GoogleCalendarConnectionStore } from "./types.js";

export class PrismaGoogleCalendarConnectionStore implements GoogleCalendarConnectionStore {
  public constructor(private readonly database: PrismaClient, private readonly encryptionKey: string) {}

  public async connectCalendar(input: ConnectGoogleCalendarInput): Promise<GoogleCalendarConnectionRecord> {
    const encrypted = input.refreshToken ? encryptRefreshToken(input.refreshToken, this.encryptionKey) : undefined;
    const connection = await this.database.$transaction(async (transaction) => {
      const existing = await transaction.googleCalendarConnection.findUnique({ where: { userId: input.userId } });
      const saved = existing
        ? await transaction.googleCalendarConnection.update({
            where: { userId: input.userId },
            data: {
              providerSubject: input.subject,
              providerEmailNormalized: input.email,
              status: "active",
              grantedScopes: input.grantedScopes,
              connectedAt: input.connectedAt,
              disconnectedAt: null,
              ...(encrypted ? {
                refreshTokenCiphertext: encrypted.ciphertext,
                refreshTokenNonce: encrypted.nonce,
                refreshTokenAuthTag: encrypted.authTag,
                tokenEncryptionKeyVersion: encrypted.keyVersion
              } : {})
            }
          })
        : await transaction.googleCalendarConnection.create({
            data: {
              userId: input.userId,
              providerSubject: input.subject,
              providerEmailNormalized: input.email,
              status: "active",
              grantedScopes: input.grantedScopes,
              connectedAt: input.connectedAt,
              disconnectedAt: null,
              refreshTokenCiphertext: encrypted?.ciphertext ?? null,
              refreshTokenNonce: encrypted?.nonce ?? null,
              refreshTokenAuthTag: encrypted?.authTag ?? null,
              tokenEncryptionKeyVersion: encrypted?.keyVersion ?? null
            }
          });
      await transaction.auditLog.create({
        data: {
          userId: input.userId,
          actorType: "user",
          eventType: "google_calendar.connected",
          entityType: "google_calendar_connection",
          entityId: saved.id,
          metadata: { grantedScopes: input.grantedScopes }
        }
      });
      return saved;
    });
    return mapConnection(connection);
  }

  public async getConnection(userId: string): Promise<GoogleCalendarConnectionRecord | null> {
    const connection = await this.database.googleCalendarConnection.findUnique({ where: { userId } });
    return connection ? mapConnection(connection) : null;
  }

  public async getDecryptedRefreshToken(userId: string): Promise<string | null> {
    const connection = await this.database.googleCalendarConnection.findUnique({
      where: { userId },
      select: {
        refreshTokenCiphertext: true,
        refreshTokenNonce: true,
        refreshTokenAuthTag: true,
        tokenEncryptionKeyVersion: true
      }
    });
    if (!connection?.refreshTokenCiphertext || !connection.refreshTokenNonce || !connection.refreshTokenAuthTag) return null;
    return decryptRefreshToken({
      ciphertext: connection.refreshTokenCiphertext,
      nonce: connection.refreshTokenNonce,
      authTag: connection.refreshTokenAuthTag,
      keyVersion: connection.tokenEncryptionKeyVersion ?? "v1"
    }, this.encryptionKey);
  }

  public async markReauthRequired(userId: string): Promise<void> {
    await this.database.googleCalendarConnection.updateMany({
      where: { userId, status: "active" },
      data: { status: "reauth_required" }
    });
  }

  public async disconnectCalendar(userId: string, disconnectedAt: Date): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const changed = await transaction.googleCalendarConnection.updateMany({
        where: { userId, status: { not: "disconnected" } },
        data: {
          status: "disconnected",
          disconnectedAt,
          refreshTokenCiphertext: null,
          refreshTokenNonce: null,
          refreshTokenAuthTag: null,
          tokenEncryptionKeyVersion: null
        }
      });
      if (changed.count > 0) {
        const connection = await transaction.googleCalendarConnection.findUnique({ where: { userId }, select: { id: true } });
        if (connection) {
          await transaction.auditLog.create({
            data: {
              userId,
              actorType: "user",
              eventType: "google_calendar.disconnected",
              entityType: "google_calendar_connection",
              entityId: connection.id
            }
          });
        }
      }
    });
  }
}

function mapConnection(record: {
  id: string;
  userId: string;
  providerSubject: string;
  providerEmailNormalized: string;
  status: "active" | "reauth_required" | "disconnected";
  grantedScopes: string[];
  connectedAt: Date;
  disconnectedAt: Date | null;
}): GoogleCalendarConnectionRecord {
  return {
    id: record.id,
    userId: record.userId,
    providerSubject: record.providerSubject,
    email: record.providerEmailNormalized,
    status: record.status,
    grantedScopes: record.grantedScopes,
    connectedAt: record.connectedAt,
    disconnectedAt: record.disconnectedAt
  };
}

