import type { Logger } from "pino";
import { prisma } from "../database.js";
import { logger as defaultLogger } from "../logger.js";
import { PrismaEmailStore } from "../emails/email-store.js";
import { GmailClient } from "./client.js";
import { PrismaGmailConnectionStore } from "./connection-store.js";
import { createGoogleGmailOAuthClient } from "./google-oauth.js";
import { createRefreshingTokenProvider } from "./token-provider.js";
import { PrismaGmailSyncRunStore } from "./sync-store.js";
import { GmailSyncService } from "./sync-service.js";
import { apiEnvironment } from "../environment.js";

export function createGmailSyncService(logger: Logger = defaultLogger): GmailSyncService {
  const gmailStore = new PrismaGmailConnectionStore(prisma, apiEnvironment.GMAIL_TOKEN_ENCRYPTION_KEY);
  const gmailOAuthClient = createGoogleGmailOAuthClient({
    clientId: apiEnvironment.GOOGLE_GMAIL_OAUTH_CLIENT_ID,
    clientSecret: apiEnvironment.GOOGLE_GMAIL_OAUTH_CLIENT_SECRET
  });

  return new GmailSyncService({
    store: new PrismaGmailSyncRunStore(prisma),
    emailStore: new PrismaEmailStore(prisma),
    clientForUser: (userId) => new GmailClient({
      tokenProvider: createRefreshingTokenProvider({
        userId,
        connectionStore: gmailStore,
        oauthClient: gmailOAuthClient
      }),
      logger
    })
  });
}
