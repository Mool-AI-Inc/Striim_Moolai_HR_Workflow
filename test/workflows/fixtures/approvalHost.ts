/**
 * Tiny host workflow that parks on awaitApproval — the approval-spine test fixture (no module dependency).
 * @lifespan THROWAWAY — an approval-spine test fixture only.
 */
import type { ApprovalDecision, PendingApproval } from "../../../src/platform/domain/types.js";
import { awaitApproval } from "../../../src/platform/approvals.js";
export async function approvalHostWorkflow(pending: PendingApproval, timeout: string): Promise<ApprovalDecision | null> {
  return awaitApproval(pending, { timeout });
}
