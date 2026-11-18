import { describe, expect, it, vi } from "vitest";
import { GmailApiError, GmailNotFoundError } from "../src/gmail/api-errors.js";
import type { GmailMessage, ListHistoryResponse } from "../src/gmail/api-types.js";
import { GmailEmailParseError } from "../src/gmail/email-parser.js";
import {
  GmailSyncService,
  type GmailSyncApiClient,
  type GmailSyncEmailWriter
} from "../src/gmail/sync-service.js";
import type {
  GmailSyncConnection,
  GmailSyncMode,
  GmailSyncRunRecord,
  GmailSyncRunStore,
  GmailSyncStatus
} from "../src/gmail/sync-store.js";
import type { StoredGmailEmailReference } from "../src/emails/email-store.js";

const USER_ID = "b269e8b0-dcbd-4cf6-8a30-03fb22000380";
const CONNECTION_ID = "97cbbe26-49c8-4cc1-aa0c-9c2cc0a6ab45";
const FIXED_DATE = new Date("2026-10-29T10:00:00.000Z");

function gmailMessage(id: string): GmailMessage {
  return { id, threadId: `thread-${id}`, labelIds: ["INBOX"] };
}

function historyPage(
  historyId: string,
  records: ListHistoryResponse["history"],
  nextPageToken?: string
): ListHistoryResponse {
  return {
    historyId,
    history: records,
    ...(nextPageToken ? { nextPageToken } : {})
  };
}

function historyRecord(
  id: string,
  changes: Partial<Pick<ListHistoryResponse["history"][number],
    "messagesAdded" | "messagesDeleted" | "labelsAdded" | "labelsRemoved">>
): ListHistoryResponse["history"][number] {
  return {
    id,
    messagesAdded: [],
    messagesDeleted: [],
    labelsAdded: [],
    labelsRemoved: [],
    ...changes
  };
}

class MemorySyncStore implements GmailSyncRunStore {
  public connection: GmailSyncConnection = {
    id: CONNECTION_ID,
    status: "active",
    gmailHistoryId: "history-old"
  };
  public run: GmailSyncRunRecord | null = null;

  public async getConnectionForUser(): Promise<GmailSyncConnection> {
    return { ...this.connection };
  }

  public async getActiveRun(_userId: string, connectionId: string): Promise<GmailSyncRunRecord | null> {
    return this.run?.googleConnectionId === connectionId && !isTerminal(this.run.status)
      ? copyRun(this.run)
      : null;
  }

  public async createRun(input: {
    userId: string;
    googleConnectionId: string;
    mode: GmailSyncMode;
    startHistoryId: string;
    maxMessages: number;
  }): Promise<GmailSyncRunRecord> {
    if (this.run && !isTerminal(this.run.status)) throw new Error("active run");
    this.run = {
      id: "5f26ba2e-48f8-4d4c-8fa7-3ae8b21a557f",
      userId: input.userId,
      googleConnectionId: input.googleConnectionId,
      mode: input.mode,
      status: "pending",
      startHistoryId: input.startHistoryId,
      targetHistoryId: null,
      pageToken: null,
      nextPageToken: null,
      pendingMessageIds: [],
      maxMessages: input.maxMessages,
      listedCount: 0,
      processedCount: 0,
      failedCount: 0,
      limitReached: false,
      cancelRequestedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      safeErrorCode: null,
      startedAt: FIXED_DATE,
      completedAt: null,
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE
    };
    return copyRun(this.run);
  }

  public async getRun(_userId: string, runId: string): Promise<GmailSyncRunRecord | null> {
    return this.run?.id === runId ? copyRun(this.run) : null;
  }

  public async claimRun(
    _userId: string,
    _runId: string,
    leaseToken: string,
    _now: Date,
    leaseExpiresAt: Date
  ): Promise<GmailSyncRunRecord> {
    const run = this.requireRun();
    if (isTerminal(run.status)) return copyRun(run);
    if (run.cancelRequestedAt) return this.terminal("cancelled", _now);
    run.status = "running";
    run.leaseToken = leaseToken;
    run.leaseExpiresAt = leaseExpiresAt;
    return copyRun(run);
  }

  public async getLeasedRun(
    _userId: string,
    _runId: string,
    leaseToken: string,
    leaseExpiresAt: Date
  ): Promise<GmailSyncRunRecord> {
    const run = this.requireRun();
    if (run.status !== "running" || run.leaseToken !== leaseToken) throw new Error("lease lost");
    run.leaseExpiresAt = leaseExpiresAt;
    return copyRun(run);
  }

  public async stagePage(input: {
    userId: string;
    runId: string;
    leaseToken: string;
    messageIds: string[];
    nextPageToken: string | undefined;
    targetHistoryId: string | undefined;
    limitReached: boolean;
  }): Promise<GmailSyncRunRecord> {
    const run = this.requireLeased(input.leaseToken);
    run.pendingMessageIds = [...new Set(input.messageIds)];
    run.listedCount += run.pendingMessageIds.length;
    run.nextPageToken = input.nextPageToken ?? null;
    run.targetHistoryId = input.targetHistoryId ?? null;
    run.limitReached = input.limitReached;
    return copyRun(run);
  }

  public async finishMessage(
    _userId: string,
    _runId: string,
    leaseToken: string,
    messageId: string,
    failed: boolean,
    safeErrorCode: string | undefined,
    _now: Date,
    leaseExpiresAt: Date
  ): Promise<GmailSyncRunRecord> {
    const run = this.requireLeased(leaseToken);
    if (run.pendingMessageIds[0] !== messageId) throw new Error("queue changed");
    run.pendingMessageIds = run.pendingMessageIds.slice(1);
    run.processedCount += 1;
    if (failed) run.failedCount += 1;
    if (safeErrorCode) run.safeErrorCode = safeErrorCode;
    run.leaseExpiresAt = leaseExpiresAt;
    return copyRun(run);
  }

  public async finishStep(
    _userId: string,
    _runId: string,
    leaseToken: string,
    now: Date
  ): Promise<GmailSyncRunRecord> {
    const run = this.requireLeased(leaseToken);
    if (run.cancelRequestedAt) return this.terminal("cancelled", now);
    if (run.pendingMessageIds.length > 0) {
      run.status = "pending";
      run.leaseToken = null;
      run.leaseExpiresAt = null;
      return copyRun(run);
    }
    if (run.nextPageToken && !run.limitReached) {
      run.pageToken = run.nextPageToken;
      run.nextPageToken = null;
      run.targetHistoryId = null;
      run.status = "pending";
      run.leaseToken = null;
      run.leaseExpiresAt = null;
      return copyRun(run);
    }
    this.connection.gmailHistoryId = run.mode === "initial" ? run.startHistoryId : run.targetHistoryId;
    run.status = "completed";
    run.completedAt = now;
    run.leaseToken = null;
    run.leaseExpiresAt = null;
    return copyRun(run);
  }

  public async releasePartial(
    _userId: string,
    _runId: string,
    leaseToken: string,
    safeErrorCode: string
  ): Promise<GmailSyncRunRecord> {
    const run = this.requireLeased(leaseToken);
    run.status = "partial";
    run.safeErrorCode = safeErrorCode;
    run.leaseToken = null;
    run.leaseExpiresAt = null;
    return copyRun(run);
  }

  public async failRun(
    _userId: string,
    _runId: string,
    leaseToken: string,
    safeErrorCode: string,
    now: Date
  ): Promise<GmailSyncRunRecord> {
    const run = this.requireLeased(leaseToken);
    run.status = "failed";
    run.safeErrorCode = safeErrorCode;
    run.completedAt = now;
    run.leaseToken = null;
    run.leaseExpiresAt = null;
    return copyRun(run);
  }

  public async requireResync(
    _userId: string,
    _runId: string,
    leaseToken: string,
    now: Date
  ): Promise<GmailSyncRunRecord> {
    const run = this.requireLeased(leaseToken);
    run.status = "resync_required";
    run.safeErrorCode = "HISTORY_CURSOR_EXPIRED";
    run.completedAt = now;
    run.leaseToken = null;
    run.leaseExpiresAt = null;
    return copyRun(run);
  }

  public async requestCancellation(
    _userId: string,
    runId: string,
    now: Date
  ): Promise<GmailSyncRunRecord | null> {
    const run = this.run;
    if (!run || run.id !== runId) return null;
    if (isTerminal(run.status)) return copyRun(run);
    if (run.status === "running") run.cancelRequestedAt = now;
    else {
      run.status = "cancelled";
      run.completedAt = now;
    }
    return copyRun(run);
  }

  public async cancelActiveForConnection(
    _userId: string,
    _connectionId: string,
    now: Date
  ): Promise<void> {
    await this.requestCancellation(USER_ID, this.run?.id ?? "", now);
  }

  private requireRun(): GmailSyncRunRecord {
    if (!this.run) throw new Error("run missing");
    return this.run;
  }

  private requireLeased(leaseToken: string): GmailSyncRunRecord {
    const run = this.requireRun();
    if (run.status !== "running" || run.leaseToken !== leaseToken) throw new Error("lease lost");
    return run;
  }

  private terminal(status: GmailSyncStatus, now: Date): GmailSyncRunRecord {
    const run = this.requireRun();
    run.status = status;
    run.completedAt = now;
    run.leaseToken = null;
    run.leaseExpiresAt = null;
    return copyRun(run);
  }
}

function isTerminal(status: GmailSyncStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "resync_required" || status === "failed";
}

function copyRun(run: GmailSyncRunRecord): GmailSyncRunRecord {
  return { ...run, pendingMessageIds: [...run.pendingMessageIds] };
}

function createHarness() {
  const store = new MemorySyncStore();
  const client: GmailSyncApiClient = {
    getProfile: vi.fn(async () => ({ historyId: "history-snapshot" })),
    listMessages: vi.fn(async () => ({ messages: [] })),
    getMessage: vi.fn(async (id) => gmailMessage(id)),
    listHistory: vi.fn(async () => historyPage("history-new", []))
  };
  const upsertedIds = new Set<string>();
  const emailStore: GmailSyncEmailWriter = {
    upsertGmailMessage: vi.fn(async (_userId, _connectionId, message): Promise<StoredGmailEmailReference> => {
      upsertedIds.add(message.id);
      return {
        id: `stored-${message.id}`,
        providerMessageId: message.id,
        providerThreadId: message.threadId,
        sourceRevision: 1
      };
    }),
    markGmailMessageDeleted: vi.fn(async () => undefined)
  };
  const service = new GmailSyncService({
    store,
    emailStore,
    clientForUser: () => client,
    now: () => FIXED_DATE,
    batchSize: 25
  });
  return { store, client, emailStore, upsertedIds, service };
}

describe("Gmail sync orchestration", () => {
  it("takes a bounded initial snapshot across pages and commits the pre-list history cursor", async () => {
    const { store, client, upsertedIds, service } = createHarness();
    vi.mocked(client.listMessages)
      .mockResolvedValueOnce({ messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }], nextPageToken: "page-2" })
      .mockResolvedValueOnce({ messages: [{ id: "m3", threadId: "t3" }] });

    const started = await service.start(USER_ID, "initial", 3);
    expect(started.status).toBe("pending");
    expect(client.getProfile).toHaveBeenCalledOnce();
    expect(client.listMessages).not.toHaveBeenCalled();

    await service.processNextBatch(USER_ID, started.syncId);
    expect(client.listMessages).toHaveBeenNthCalledWith(1, { maxResults: 3 });
    const completed = await service.processNextBatch(USER_ID, started.syncId);

    expect(client.listMessages).toHaveBeenNthCalledWith(2, { maxResults: 1, pageToken: "page-2" });
    expect(upsertedIds).toEqual(new Set(["m1", "m2", "m3"]));
    expect(completed).toMatchObject({ status: "completed", listedCount: 3, processedCount: 3, maxMessages: 3 });
    expect(store.connection.gmailHistoryId).toBe("history-snapshot");
  });

  it("applies paginated message and label changes, tombstones deleted messages, and commits only the final cursor", async () => {
    const { store, client, emailStore, service } = createHarness();
    store.connection.gmailHistoryId = "history-start";
    vi.mocked(client.listHistory)
      .mockResolvedValueOnce(historyPage("history-page-1", [
        historyRecord("1", { messagesAdded: [{ message: { id: "m1" } }] }),
        historyRecord("2", { labelsRemoved: [{ message: { id: "m2" }, labelIds: ["STARRED"] }] })
      ], "history-page-token"))
      .mockResolvedValueOnce(historyPage("history-final", [
        historyRecord("2b", { labelsAdded: [{ message: { id: "m1" }, labelIds: ["IMPORTANT"] }] }),
        historyRecord("3", { messagesDeleted: [{ message: { id: "m3" } }] })
      ]));
    vi.mocked(client.getMessage).mockImplementation(async (id) => {
      if (id === "m3") throw new GmailNotFoundError();
      return gmailMessage(id);
    });

    const started = await service.start(USER_ID, "incremental");
    const firstPage = await service.processNextBatch(USER_ID, started.syncId);
    expect(firstPage.status).toBe("pending");
    expect(store.connection.gmailHistoryId).toBe("history-start");
    expect(client.listHistory).toHaveBeenNthCalledWith(1, {
      startHistoryId: "history-start",
      maxResults: 100,
      historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]
    });

    const completed = await service.processNextBatch(USER_ID, started.syncId);
    expect(client.listHistory).toHaveBeenNthCalledWith(2, {
      startHistoryId: "history-start",
      maxResults: 100,
      pageToken: "history-page-token",
      historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]
    });
    expect(emailStore.markGmailMessageDeleted).toHaveBeenCalledWith(USER_ID, CONNECTION_ID, "m3", FIXED_DATE);
    expect(emailStore.upsertGmailMessage).toHaveBeenCalledTimes(3);
    expect(completed.status).toBe("completed");
    expect(store.connection.gmailHistoryId).toBe("history-final");
  });

  it("requires a bounded full resync when Gmail has expired the saved history cursor", async () => {
    const { store, client, service } = createHarness();
    store.connection.gmailHistoryId = "expired-history";
    vi.mocked(client.listHistory).mockRejectedValue(new GmailNotFoundError());

    const started = await service.start(USER_ID, "incremental");
    const result = await service.processNextBatch(USER_ID, started.syncId);

    expect(result).toMatchObject({ status: "resync_required", safeErrorCode: "HISTORY_CURSOR_EXPIRED" });
    expect(store.connection.gmailHistoryId).toBe("expired-history");
  });

  it("keeps the old cursor and pending message checkpoint after a transient failure, then safely retries", async () => {
    const { store, client, service } = createHarness();
    store.connection.gmailHistoryId = "history-start";
    vi.mocked(client.listHistory).mockResolvedValue(
      historyPage("history-commit", [historyRecord("1", { messagesAdded: [{ message: { id: "m1" } }] })])
    );
    vi.mocked(client.getMessage)
      .mockRejectedValueOnce(new GmailApiError(503, "GMAIL_SERVER_ERROR", "temporary", true))
      .mockResolvedValueOnce(gmailMessage("m1"));

    const started = await service.start(USER_ID, "incremental");
    const partial = await service.processNextBatch(USER_ID, started.syncId);
    expect(partial.status).toBe("partial");
    expect(store.connection.gmailHistoryId).toBe("history-start");

    const completed = await service.processNextBatch(USER_ID, started.syncId);
    expect(completed.status).toBe("completed");
    expect(client.getMessage).toHaveBeenCalledTimes(2);
    expect(store.connection.gmailHistoryId).toBe("history-commit");
  });

  it("does not advance a history cursor when a message fails permanent parsing", async () => {
    const { store, client, emailStore, service } = createHarness();
    store.connection.gmailHistoryId = "history-start";
    vi.mocked(client.listHistory).mockResolvedValue(
      historyPage("history-new", [historyRecord("1", { messagesAdded: [{ message: { id: "bad-message" } }] })])
    );
    vi.mocked(emailStore.upsertGmailMessage).mockRejectedValue(
      new GmailEmailParseError("INVALID_BODY_ENCODING")
    );

    const started = await service.start(USER_ID, "incremental");
    const result = await service.processNextBatch(USER_ID, started.syncId);

    expect(result).toMatchObject({ status: "failed", processedCount: 1, failedCount: 1 });
    expect(store.connection.gmailHistoryId).toBe("history-start");
  });

  it("cancels a pending run without starting another Gmail request", async () => {
    const { client, service } = createHarness();
    const started = await service.start(USER_ID, "initial", 10);
    const cancelled = await service.cancel(USER_ID, started.syncId);

    expect(cancelled.status).toBe("cancelled");
    expect((await service.processNextBatch(USER_ID, started.syncId)).status).toBe("cancelled");
    expect(client.listMessages).not.toHaveBeenCalled();
  });

  it("honors cancellation between messages in an active batch", async () => {
    const { client, emailStore, service } = createHarness();
    vi.mocked(client.listMessages).mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }]
    });
    const started = await service.start(USER_ID, "initial", 10);
    vi.mocked(client.getMessage).mockImplementationOnce(async (id) => {
      await service.cancel(USER_ID, started.syncId);
      return gmailMessage(id);
    });

    const result = await service.processNextBatch(USER_ID, started.syncId);

    expect(result.status).toBe("cancelled");
    expect(emailStore.upsertGmailMessage).toHaveBeenCalledTimes(1);
    expect(client.getMessage).toHaveBeenCalledTimes(1);
  });
});
