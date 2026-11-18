import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import { GmailEmailParseError } from "./email-parser.js";
import {
  GmailApiError,
  GmailNotFoundError,
  GmailReauthRequiredError,
  isTransientGmailError
} from "./api-errors.js";
import type { GmailMessage, ListHistoryResponse } from "./api-types.js";
import type { StoredGmailEmailReference } from "../emails/email-store.js";
import type { GmailSyncMode, GmailSyncRunRecord, GmailSyncRunStore, GmailSyncStatus } from "./sync-store.js";

export const DEFAULT_INITIAL_SYNC_MAX_MESSAGES = 500;
export const MAX_INITIAL_SYNC_MESSAGES = 2_000;
export const GMAIL_SYNC_BATCH_SIZE = 25;
const GMAIL_HISTORY_PAGE_SIZE = 100;
const SYNC_LEASE_MS = 5 * 60_000;

export interface GmailSyncApiClient {
  getProfile(): Promise<{ historyId: string }>;
  listMessages(options: { maxResults: number; pageToken?: string }): Promise<{
    messages: Array<{ id: string; threadId: string }>;
    nextPageToken?: string | undefined;
  }>;
  getMessage(messageId: string, options?: { format?: "full" }): Promise<GmailMessage>;
  listHistory(options: {
    startHistoryId: string;
    maxResults: number;
    pageToken?: string;
    historyTypes: Array<"messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved">;
  }): Promise<ListHistoryResponse>;
}

export interface GmailSyncEmailWriter {
  upsertGmailMessage(
    userId: string,
    googleConnectionId: string,
    message: GmailMessage
  ): Promise<StoredGmailEmailReference>;
  markGmailMessageDeleted(
    userId: string,
    googleConnectionId: string,
    providerMessageId: string,
    deletedAt: Date
  ): Promise<void>;
}

export interface GmailSyncProgress {
  syncId: string;
  mode: GmailSyncMode;
  status: GmailSyncStatus;
  listedCount: number;
  processedCount: number;
  failedCount: number;
  maxMessages: number | null;
  limitReached: boolean;
  safeErrorCode: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface GmailSyncServiceOptions {
  store: GmailSyncRunStore;
  emailStore: GmailSyncEmailWriter;
  clientForUser: (userId: string) => GmailSyncApiClient;
  now?: () => Date;
  batchSize?: number;
}

export class GmailSyncService {
  private readonly now: () => Date;
  private readonly batchSize: number;

  public constructor(private readonly options: GmailSyncServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.batchSize = options.batchSize ?? GMAIL_SYNC_BATCH_SIZE;
  }

  public async start(
    userId: string,
    mode: GmailSyncMode,
    requestedMaxMessages?: number
  ): Promise<GmailSyncProgress> {
    const maxMessages = requestedMaxMessages ?? DEFAULT_INITIAL_SYNC_MAX_MESSAGES;
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > MAX_INITIAL_SYNC_MESSAGES) {
      throw new ApiError(400, "INVALID_ARGUMENT", "maxMessages is outside the allowed sync limit");
    }

    const connection = await this.options.store.getConnectionForUser(userId);
    if (!connection || connection.status !== "active") {
      throw new ApiError(409, "GMAIL_CONNECTION_NOT_ACTIVE", "Connect Gmail before starting a sync");
    }
    const activeRun = await this.options.store.getActiveRun(userId, connection.id);
    if (activeRun) throw new ApiError(409, "SYNC_ALREADY_ACTIVE", "A Gmail sync is already active");

    let startHistoryId = connection.gmailHistoryId;
    if (mode === "initial") {
      try {
        startHistoryId = (await this.options.clientForUser(userId).getProfile()).historyId;
      } catch (error: unknown) {
        if (error instanceof GmailReauthRequiredError) {
          throw new ApiError(409, "REAUTH_REQUIRED", "Reconnect Gmail before starting a sync");
        }
        if (error instanceof GmailApiError) {
          throw new ApiError(
            error.statusCode,
            error.code,
            "Gmail could not start the requested sync",
            error.retryable
          );
        }
        throw error;
      }
    } else if (!startHistoryId) {
      throw new ApiError(409, "INITIAL_SYNC_REQUIRED", "Run an initial Gmail sync before requesting incremental sync");
    }

    const run = await this.options.store.createRun({
      userId,
      googleConnectionId: connection.id,
      mode,
      startHistoryId,
      maxMessages: mode === "initial" ? maxMessages : MAX_INITIAL_SYNC_MESSAGES
    });
    return toProgress(run);
  }

  public async getProgress(userId: string, runId: string): Promise<GmailSyncProgress> {
    const run = await this.options.store.getRun(userId, runId);
    if (!run) throw new ApiError(404, "SYNC_NOT_FOUND", "Gmail sync was not found");
    return toProgress(run);
  }

  public async cancel(userId: string, runId: string): Promise<GmailSyncProgress> {
    const run = await this.options.store.requestCancellation(userId, runId, this.now());
    if (!run) throw new ApiError(404, "SYNC_NOT_FOUND", "Gmail sync was not found");
    return toProgress(run);
  }

  public async cancelActiveForConnection(userId: string, googleConnectionId: string): Promise<void> {
    await this.options.store.cancelActiveForConnection(userId, googleConnectionId, this.now());
  }

  public async processNextBatch(userId: string, runId: string): Promise<GmailSyncProgress> {
    const now = this.now();
    const leaseToken = randomUUID();
    let run = await this.options.store.claimRun(
      userId,
      runId,
      leaseToken,
      now,
      new Date(now.getTime() + SYNC_LEASE_MS)
    );
    if (isTerminalStatus(run.status)) return toProgress(run);
    const client = this.options.clientForUser(userId);

    try {
      run = await this.options.store.getLeasedRun(
        userId,
        runId,
        leaseToken,
        new Date(this.now().getTime() + SYNC_LEASE_MS)
      );
      if (run.cancelRequestedAt) {
        return toProgress(await this.options.store.finishStep(userId, runId, leaseToken, this.now()));
      }

      if (run.pendingMessageIds.length === 0) {
        try {
          if (run.mode === "initial") {
            const remaining = run.maxMessages - run.listedCount;
            if (remaining <= 0) {
              await this.options.store.stagePage({
                userId,
                runId,
                leaseToken,
                messageIds: [],
                nextPageToken: undefined,
                targetHistoryId: undefined,
                limitReached: true
              });
            } else {
              const page = await client.listMessages({
                maxResults: Math.min(this.batchSize, remaining),
                ...(run.pageToken ? { pageToken: run.pageToken } : {})
              });
              const ids = [...new Set(page.messages.map((message) => message.id))];
              await this.options.store.stagePage({
                userId,
                runId,
                leaseToken,
                messageIds: ids,
                nextPageToken: page.nextPageToken,
                targetHistoryId: undefined,
                limitReached: Boolean(page.nextPageToken && run.listedCount + ids.length >= run.maxMessages)
              });
            }
          } else {
            const page = await client.listHistory({
              startHistoryId: run.startHistoryId ?? "",
              maxResults: GMAIL_HISTORY_PAGE_SIZE,
              ...(run.pageToken ? { pageToken: run.pageToken } : {}),
              historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]
            });
            const ids = collectChangedMessageIds(page);
            await this.options.store.stagePage({
              userId,
              runId,
              leaseToken,
              messageIds: ids,
              nextPageToken: page.nextPageToken,
              targetHistoryId: page.historyId,
              limitReached: false
            });
          }
        } catch (error: unknown) {
          if (run.mode === "incremental" && error instanceof GmailNotFoundError) {
            return toProgress(await this.options.store.requireResync(userId, runId, leaseToken, this.now()));
          }
          return toProgress(await this.finishPageFailure(userId, runId, leaseToken, error));
        }
      }

      let processedThisBatch = 0;
      while (processedThisBatch < this.batchSize) {
        run = await this.options.store.getLeasedRun(
          userId,
          runId,
          leaseToken,
          new Date(this.now().getTime() + SYNC_LEASE_MS)
        );
        if (run.cancelRequestedAt || run.pendingMessageIds.length === 0) break;
        const messageId = run.pendingMessageIds[0];
        if (!messageId) break;

        try {
          const message = await client.getMessage(messageId, { format: "full" });
          await this.options.emailStore.upsertGmailMessage(userId, run.googleConnectionId, message);
          await this.options.store.finishMessage(
            userId,
            runId,
            leaseToken,
            messageId,
            false,
            undefined,
            this.now(),
            new Date(this.now().getTime() + SYNC_LEASE_MS)
          );
        } catch (error: unknown) {
          if (error instanceof GmailNotFoundError) {
            try {
              await this.options.emailStore.markGmailMessageDeleted(
                userId,
                run.googleConnectionId,
                messageId,
                this.now()
              );
              await this.options.store.finishMessage(
                userId,
                runId,
                leaseToken,
                messageId,
                false,
                undefined,
                this.now(),
                new Date(this.now().getTime() + SYNC_LEASE_MS)
              );
            } catch {
              return toProgress(await this.options.store.releasePartial(
                userId,
                runId,
                leaseToken,
                "EMAIL_STORE_RETRYABLE_FAILURE"
              ));
            }
          } else if (error instanceof GmailReauthRequiredError) {
            return toProgress(await this.options.store.failRun(
              userId,
              runId,
              leaseToken,
              "GMAIL_REAUTH_REQUIRED",
              this.now()
            ));
          } else if (isTransientGmailError(error)) {
            return toProgress(await this.options.store.releasePartial(
              userId,
              runId,
              leaseToken,
              error instanceof GmailApiError ? error.code : "GMAIL_TEMPORARY_FAILURE"
            ));
          } else if (error instanceof GmailEmailParseError) {
            await this.options.store.finishMessage(
              userId,
              runId,
              leaseToken,
              messageId,
              true,
              error.code,
              this.now(),
              new Date(this.now().getTime() + SYNC_LEASE_MS)
            );
          } else if (error instanceof ApiError && error.code === "GMAIL_CONNECTION_NOT_FOUND") {
            return toProgress(await this.options.store.failRun(
              userId,
              runId,
              leaseToken,
              "GMAIL_CONNECTION_NOT_ACTIVE",
              this.now()
            ));
          } else if (error instanceof GmailApiError) {
            await this.options.store.finishMessage(
              userId,
              runId,
              leaseToken,
              messageId,
              true,
              error.code,
              this.now(),
              new Date(this.now().getTime() + SYNC_LEASE_MS)
            );
          } else {
            return toProgress(await this.options.store.releasePartial(
              userId,
              runId,
              leaseToken,
              "EMAIL_STORE_RETRYABLE_FAILURE"
            ));
          }
        }
        processedThisBatch += 1;
      }

      return toProgress(await this.options.store.finishStep(userId, runId, leaseToken, this.now()));
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      return toProgress(await this.options.store.releasePartial(
        userId,
        runId,
        leaseToken,
        "SYNC_STEP_RETRYABLE_FAILURE"
      ));
    }
  }

  private async finishPageFailure(
    userId: string,
    runId: string,
    leaseToken: string,
    error: unknown
  ): Promise<GmailSyncRunRecord> {
    if (error instanceof GmailReauthRequiredError) {
      return this.options.store.failRun(userId, runId, leaseToken, "GMAIL_REAUTH_REQUIRED", this.now());
    }
    if (isTransientGmailError(error)) {
      return this.options.store.releasePartial(
        userId,
        runId,
        leaseToken,
        error instanceof GmailApiError ? error.code : "GMAIL_TEMPORARY_FAILURE"
      );
    }
    return this.options.store.failRun(
      userId,
      runId,
      leaseToken,
      error instanceof GmailApiError ? error.code : "SYNC_PAGE_FAILED",
      this.now()
    );
  }
}

function collectChangedMessageIds(page: ListHistoryResponse): string[] {
  const ids = new Set<string>();
  for (const record of page.history) {
    for (const change of record.messagesAdded) ids.add(change.message.id);
    for (const change of record.messagesDeleted) ids.add(change.message.id);
    for (const change of record.labelsAdded) ids.add(change.message.id);
    for (const change of record.labelsRemoved) ids.add(change.message.id);
  }
  return [...ids];
}

function toProgress(run: GmailSyncRunRecord): GmailSyncProgress {
  return {
    syncId: run.id,
    mode: run.mode,
    status: run.status,
    listedCount: run.listedCount,
    processedCount: run.processedCount,
    failedCount: run.failedCount,
    maxMessages: run.mode === "initial" ? run.maxMessages : null,
    limitReached: run.limitReached,
    safeErrorCode: run.safeErrorCode,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null
  };
}

function isTerminalStatus(status: GmailSyncStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "resync_required" || status === "failed";
}
