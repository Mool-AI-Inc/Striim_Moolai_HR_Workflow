/**
 * benefitsDay60Send — UC2b Day-60 Employee Navigator send (human confirm → file-drop send).
 * @lifespan PRODUCTION — the real orchestration; the file-drop is the robot stand-in behind the connector.
 * @responsibility Park for a human confirm, then stage the EN send (or alarm on reject/expiry).
 */
import * as wf from "@temporalio/workflow";
import type { PendingApproval } from "../../platform/domain/types.js";
import { awaitApproval } from "../../platform/approvals.js";

const { stageSend, alarmDidNotSend } = wf.proxyActivities<{
  stageSend(companyId: string, employeeId: string): Promise<{ receiptId: string }>;
  alarmDidNotSend(a: { employeeId: string; template: string; reason: string }): Promise<void>;
}>({ startToCloseTimeout: "1 minute" });

export async function benefitsDay60Send({ companyId, employeeId }: { companyId: string; employeeId: string }): Promise<void> {
  const pending: PendingApproval = {
    id: `benefits:${employeeId}`, workflowId: wf.workflowInfo().workflowId,
    kind: "benefits-send", title: `EN Day-60 send for ${employeeId}`, detail: { doc: "benefits-summary.pdf" },
    createdAt: new Date().toISOString(), status: "pending",
  };
  const decision = await awaitApproval(pending, { timeout: "14 days" });                    // human confirm (UC2b)
  if (decision?.approved) await stageSend(companyId, employeeId);                            // robot write → file drop
  else await alarmDidNotSend({ employeeId, template: "benefits-send", reason: decision ? "rejected" : "expired" });
}
