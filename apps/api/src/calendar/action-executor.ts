import { createHash } from "node:crypto";
import type { ActionProposalSnapshot } from "@mailpilot/shared";
import { GoogleCalendarScope } from "@mailpilot/shared";
import type { ActionExecutionContext, ActionExecutionResult, ActionExecutor, ActionReconciler, ReconciliationResult } from "../actions/executor.js";
import { MockActionExecutor, MockActionReconciler } from "../actions/executor.js";
import { GoogleCalendarReauthRequiredError, type GoogleCalendarOAuthClient } from "./google-oauth.js";
import { CalendarApiError, type CalendarEventApi, type CalendarEventSnapshot } from "./calendar-api.js";
import type { GoogleCalendarConnectionStore } from "./types.js";

export interface CalendarActionRuntimeOptions {
  enabled: boolean;
  connectionStore: GoogleCalendarConnectionStore;
  oauthClient: GoogleCalendarOAuthClient;
  calendarApi: CalendarEventApi;
  mockExecutor?: ActionExecutor;
  mockReconciler?: ActionReconciler;
}

export class CalendarActionRuntime implements ActionExecutor, ActionReconciler {
  private readonly mockExecutor: ActionExecutor;
  private readonly mockReconciler: ActionReconciler;

  public constructor(private readonly options: CalendarActionRuntimeOptions) {
    this.mockExecutor = options.mockExecutor ?? new MockActionExecutor();
    this.mockReconciler = options.mockReconciler ?? new MockActionReconciler();
  }

  public async execute(snapshot: ActionProposalSnapshot, context: ActionExecutionContext): Promise<ActionExecutionResult> {
    if (snapshot.actionType !== "create_calendar_event") return this.mockExecutor.execute(snapshot, context);
    if (snapshot.userId !== context.userId) return { status: "failed", resultCode: "ACTION_OWNER_MISMATCH" };
    if (!this.options.enabled) return { status: "failed", resultCode: "CALENDAR_CREATION_DISABLED" };

    const accessToken = await this.accessToken(context.userId);
    if (!accessToken) return { status: "failed", resultCode: "CALENDAR_CONNECTION_REQUIRED" };
    try {
      await this.options.calendarApi.createEvent(accessToken, toCalendarSnapshot(snapshot), context.idempotencyKey, context.signal);
      return { status: "succeeded" };
    } catch (error: unknown) {
      if (!(error instanceof CalendarApiError)) return { status: "uncertain" };
      if (error.kind === "unauthorized") {
        await this.options.connectionStore.markReauthRequired(context.userId).catch(() => undefined);
        return { status: "failed", resultCode: "CALENDAR_REAUTH_REQUIRED" };
      }
      if (error.kind === "conflict") {
        try {
          const result = await this.options.calendarApi.reconcileEvent(accessToken, toCalendarSnapshot(snapshot), context.idempotencyKey, context.signal);
          return result === "succeeded"
            ? { status: "succeeded" }
            : { status: "failed", resultCode: "CALENDAR_EVENT_CONFLICT" };
        } catch {
          return { status: "uncertain" };
        }
      }
      return error.kind === "transient"
        ? { status: "uncertain", resultCode: "CALENDAR_OUTCOME_UNKNOWN" }
        : { status: "failed", resultCode: "CALENDAR_PROVIDER_REJECTED" };
    }
  }

  public async reconcile(snapshot: ActionProposalSnapshot, context: ActionExecutionContext): Promise<ReconciliationResult> {
    if (snapshot.actionType !== "create_calendar_event") return this.mockReconciler.reconcile(snapshot, context);
    if (snapshot.userId !== context.userId) return "unknown";
    if (!this.options.enabled) return "unknown";
    const accessToken = await this.accessToken(context.userId);
    if (!accessToken) return "unknown";
    try {
      return await this.options.calendarApi.reconcileEvent(
        accessToken,
        toCalendarSnapshot(snapshot),
        context.idempotencyKey,
        context.signal
      );
    } catch (error: unknown) {
      if (error instanceof CalendarApiError && error.kind === "unauthorized") {
        await this.options.connectionStore.markReauthRequired(context.userId).catch(() => undefined);
      }
      return "unknown";
    }
  }

  private async accessToken(userId: string): Promise<string | null> {
    const connection = await this.options.connectionStore.getConnection(userId);
    if (!connection || connection.status !== "active" || !connection.grantedScopes.includes(GoogleCalendarScope)) return null;
    const refreshToken = await this.options.connectionStore.getDecryptedRefreshToken(userId);
    if (!refreshToken) {
      await this.options.connectionStore.markReauthRequired(userId).catch(() => undefined);
      return null;
    }
    try {
      const refreshed = await this.options.oauthClient.refreshAccessToken(refreshToken);
      return refreshed.accessToken;
    } catch (error: unknown) {
      if (error instanceof GoogleCalendarReauthRequiredError) {
        await this.options.connectionStore.markReauthRequired(userId).catch(() => undefined);
      }
      return null;
    }
  }
}

function toCalendarSnapshot(snapshot: Extract<ActionProposalSnapshot, { actionType: "create_calendar_event" }>): CalendarEventSnapshot {
  return {
    actionType: snapshot.actionType,
    payload: snapshot.payload,
    sourceEvidence: snapshot.sourceEvidence,
    payloadHash: snapshotHash(snapshot)
  };
}

function snapshotHash(snapshot: ActionProposalSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Invalid calendar proposal snapshot");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
