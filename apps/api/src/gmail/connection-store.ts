import type { PrismaClient } from "../generated/prisma/client.js";
import { decryptRefreshToken, encryptRefreshToken } from "./token-encryption.js";
import type {
  ConnectGmailInput,
  GmailConnectionRecord,
  GmailConnectionStore
} from "./types.js";

export class PrismaGmailConnectionStore implements GmailConnectionStore {
  public constructor(
    private readonly database: PrismaClient,
    private readonly encryptionKey: string
  ) {}

  public async connectGmail(input: ConnectGmailInput): Promise<GmailConnectionRecord> {
    const existing = await this.database.googleConnection.findUnique({
      where: { userId: input.userId }
    });

    const encrypted = input.refreshToken
      ? encryptRefreshToken(input.refreshToken, this.encryptionKey)
      : undefined;

    if (existing) {
      const updated = await this.database.googleConnection.update({
        where: { userId: input.userId },
        data: {
          providerSubject: input.subject,
          providerEmailNormalized: input.email,
          status: "active",
          grantedScopes: input.grantedScopes,
          connectedAt: input.connectedAt,
          disconnectedAt: null,
          ...(encrypted
            ? {
                refreshTokenCiphertext: encrypted.ciphertext,
                refreshTokenNonce: encrypted.nonce,
                refreshTokenAuthTag: encrypted.authTag,
                tokenEncryptionKeyVersion: encrypted.keyVersion
              }
            : {})
        }
      });
      return this.mapRecord(updated);
    }

    const created = await this.database.googleConnection.create({
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
    return this.mapRecord(created);
  }

  public async getConnection(userId: string): Promise<GmailConnectionRecord | null> {
    const connection = await this.database.googleConnection.findUnique({
      where: { userId }
    });
    if (!connection) return null;
    return this.mapRecord(connection);
  }

  public async getDecryptedRefreshToken(userId: string): Promise<string | null> {
    const connection = await this.database.googleConnection.findUnique({
      where: { userId }
    });
    if (
      !connection ||
      !connection.refreshTokenCiphertext ||
      !connection.refreshTokenNonce ||
      !connection.refreshTokenAuthTag
    ) {
      return null;
    }

    return decryptRefreshToken(
      {
        ciphertext: connection.refreshTokenCiphertext,
        nonce: connection.refreshTokenNonce,
        authTag: connection.refreshTokenAuthTag,
        keyVersion: connection.tokenEncryptionKeyVersion ?? "v1"
      },
      this.encryptionKey
    );
  }

  public async markReauthRequired(userId: string): Promise<void> {
    await this.database.googleConnection.updateMany({
      where: { userId, status: "active" },
      data: { status: "reauth_required" }
    });
  }

  public async disconnectGmail(userId: string, disconnectedAt: Date): Promise<void> {
    await this.database.googleConnection.updateMany({
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
  }

  private mapRecord(record: {
    id: string;
    userId: string;
    providerSubject: string;
    providerEmailNormalized: string;
    status: "active" | "reauth_required" | "disconnected";
    grantedScopes: string[];
    connectedAt: Date;
    disconnectedAt: Date | null;
    lastSuccessfulSyncAt: Date | null;
  }): GmailConnectionRecord {
    return {
      id: record.id,
      userId: record.userId,
      providerSubject: record.providerSubject,
      providerEmailNormalized: record.providerEmailNormalized,
      status: record.status,
      grantedScopes: record.grantedScopes,
      connectedAt: record.connectedAt,
      disconnectedAt: record.disconnectedAt,
      lastSuccessfulSyncAt: record.lastSuccessfulSyncAt
    };
  }
}

