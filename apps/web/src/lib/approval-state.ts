export type ApprovalDecision = "approved" | "rejected";
export type ApprovalDecisions = Record<string, ApprovalDecision>;

export type ApprovalAction = { type: "decide"; id: string; decision: ApprovalDecision } | { type: "reset" };

export function approvalReducer(state: ApprovalDecisions, action: ApprovalAction): ApprovalDecisions {
  if (action.type === "reset") return {};
  if (state[action.id]) return state;
  return { ...state, [action.id]: action.decision };
}
