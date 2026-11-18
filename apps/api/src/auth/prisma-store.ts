import type { PrismaClient } from "../generated/prisma/client.js";
import { AuthenticationRejectedError, type AuthStore, type CreateSessionInput, type GoogleIdentity } from "./types.js";

const GOOGLE_PROVIDER = "google";

export class PrismaAuthStore implements AuthStore {
  public constructor(private readonly database: PrismaClient) {}

  public async authenticateGoogleIdentity(identity: GoogleIdentity, authenticatedAt: Date) {
    const existingIdentity = await this.findGoogleIdentity(identity.subject);
    if (existingIdentity) {
      if (existingIdentity.user.status !== "active") throw new AuthenticationRejectedError();
      await this.database.authenticationIdentity.update({
        where: { id: existingIdentity.id, userId: existingIdentity.userId },
        data: {
          emailNormalized: identity.email,
          emailVerifiedAt: authenticatedAt,
          lastAuthenticatedAt: authenticatedAt
        }
      });
      return {
        id: existingIdentity.user.id,
        emailNormalized: existingIdentity.user.emailNormalized,
        status: existingIdentity.user.status
      };
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.database.$transaction(async (transaction) => {
          const matchedUser = await transaction.user.findUnique({ where: { emailNormalized: identity.email } });
          const user = matchedUser ?? await transaction.user.create({ data: { emailNormalized: identity.email } });
          if (user.status !== "active") throw new AuthenticationRejectedError();

          await transaction.authenticationIdentity.create({
            data: {
              userId: user.id,
              provider: GOOGLE_PROVIDER,
              providerSubject: identity.subject,
              emailNormalized: identity.email,
              emailVerifiedAt: authenticatedAt,
              lastAuthenticatedAt: authenticatedAt
            }
          });

          return { id: user.id, emailNormalized: user.emailNormalized, status: user.status };
        });
      } catch (error: unknown) {
        if (!isUniqueConstraintError(error)) throw error;
        const racedIdentity = await this.findGoogleIdentity(identity.subject);
        if (racedIdentity) {
          if (racedIdentity.user.status !== "active") throw new AuthenticationRejectedError();
          return {
            id: racedIdentity.user.id,
            emailNormalized: racedIdentity.user.emailNormalized,
            status: racedIdentity.user.status
          };
        }
        if (attempt === 1) throw error;
      }
    }

    throw new AuthenticationRejectedError();
  }

  public async createSession(input: CreateSessionInput): Promise<{ id: string }> {
    return this.database.session.create({
      data: input,
      select: { id: true }
    });
  }

  public async findSessionByTokenHash(tokenHash: string) {
    return this.database.session.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        csrfTokenHash: true,
        expiresAt: true,
        revokedAt: true,
        user: { select: { emailNormalized: true, status: true } }
      }
    });
  }

  public async revokeSession(sessionId: string, userId: string, revokedAt: Date): Promise<void> {
    await this.database.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt }
    });
  }

  private async findGoogleIdentity(subject: string) {
    return this.database.authenticationIdentity.findUnique({
      where: { provider_providerSubject: { provider: GOOGLE_PROVIDER, providerSubject: subject } },
      include: { user: true }
    });
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}
