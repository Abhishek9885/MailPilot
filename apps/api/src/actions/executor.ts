import type { ActionProposalSnapshot } from "@mailpilot/shared";

export interface ActionExecutionContext {
  userId: string;
  /** Stable across retries; provider adapters must pass this through as their idempotency key. */
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface ActionExecutionResult {
  /** `failed` means the executor can prove no external effect occurred. */
  status: "succeeded" | "failed" | "partial" | "uncertain";
  resultCode?: string;
}

export interface ActionExecutor {
  execute(snapshot: ActionProposalSnapshot, context: ActionExecutionContext): Promise<ActionExecutionResult>;
}

export type ReconciliationResult = "succeeded" | "failed" | "not_executed" | "unknown";

export interface ActionReconciler {
  reconcile(snapshot: ActionProposalSnapshot, context: ActionExecutionContext): Promise<ReconciliationResult>;
}

/** Local-only executor. It deliberately performs no provider, database, or network actions. */
export class MockActionExecutor implements ActionExecutor {
  public async execute(
    snapshot: ActionProposalSnapshot,
    context: ActionExecutionContext
  ): Promise<ActionExecutionResult> {
    void snapshot;
    void context;
    return { status: "succeeded" };
  }
}

/** Safe default: an outcome cannot be assumed from missing provider support. */
export class MockActionReconciler implements ActionReconciler {
  public async reconcile(
    snapshot: ActionProposalSnapshot,
    context: ActionExecutionContext
  ): Promise<ReconciliationResult> {
    void snapshot;
    void context;
    return "unknown";
  }
}
