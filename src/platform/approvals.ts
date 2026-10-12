/**
 * Human-in-the-loop approval — Temporal Workflow Update (Update > Signal for web-driven decisions).
 * @lifespan PRODUCTION — the review spine for UC3/UC4/UC6/UC2b; also the compliance audit trail.
 * @responsibility Park on a validated approve/reject Update, expire after a bound, mirror state to the DB inbox.
 */
import * as wf from "@temporalio/workflow";
import type { ApprovalDecision, PendingApproval } from "./domain/types.js";
export const decideUpdate = wf.defineUpdate<"recorded", [ApprovalDecision]>("decide");
export const pendingQuery = wf.defineQuery<PendingApproval | null>("pending");
const { registerPending, resolvePending } = wf.proxyActivities<{
  registerPending(p: PendingApproval): Promise<void>;
  resolvePending(id: string, status: PendingApproval["status"]): Promise<void>;
}>({ startToCloseTimeout: "30 seconds" });
export async function awaitApproval(pending: PendingApproval, opts: { timeout: string }): Promise<ApprovalDecision | null> {
  let decision: ApprovalDecision | undefined;
  wf.setHandler(decideUpdate, (d) => { decision = d; return "recorded"; }, {
    validator: (d) => {
      if (decision) throw wf.ApplicationFailure.nonRetryable("already decided");
      if (!d.reason) throw wf.ApplicationFailure.nonRetryable("reason required");
    },
  });
  wf.setHandler(pendingQuery, () => (decision ? null : pending));
  await registerPending(pending);
  const decided = await wf.condition(() => decision !== undefined, opts.timeout);
  await resolvePending(pending.id, decided ? (decision!.approved ? "approved" : "rejected") : "expired");
  return decided ? decision! : null;
}
