/**
 * packetSelection — UC6 recommend → human confirm (choose docs) → file-drop assign + email the hire.
 * @lifespan PRODUCTION — the real orchestration; the file-drop is the robot stand-in behind the connector.
 * @responsibility Recommend a packet, park for a human confirm, then assign the chosen docs + email them (or alarm).
 */
import * as wf from "@temporalio/workflow";
import type { EmployeeRecord, PacketRecommendation, PacketApprovalDetail, TransactionalEmail } from "../../platform/domain/types.js";
import { TEMPLATE } from "../../platform/domain/types.js";
import { awaitApproval } from "../../platform/approvals.js";
import { packetFor, ALL_PACKETS } from "./decisionTable.js";

const { getEmployee, recommendPacket, assignPacket, sendEmail, alarmDidNotSend } = wf.proxyActivities<{
  getEmployee(companyId: string, employeeId: string): Promise<EmployeeRecord>;
  recommendPacket(companyId: string, employeeId: string): Promise<PacketRecommendation>;
  assignPacket(companyId: string, employeeId: string, packetId: string, docs: string[]): Promise<{ receiptId: string }>;
  sendEmail(email: TransactionalEmail): Promise<{ messageId: string } | { skipped: true }>;
  alarmDidNotSend(a: { employeeId: string; template: string; reason: string }): Promise<void>;
}>({ startToCloseTimeout: "1 minute" });

export async function packetSelection({ companyId, employeeId }: { companyId: string; employeeId: string }): Promise<void> {
  const e = await getEmployee(companyId, employeeId);
  const rec = await recommendPacket(companyId, employeeId);
  const packet = ALL_PACKETS.find((p) => p.packetId === rec.packetId) ?? packetFor(e);   // the recommended packet's contents
  const detail: PacketApprovalDetail = {
    ...rec, label: packet.label, requiredDocs: packet.requiredDocs,
    employeeType: e.employeeType, costCenter: e.costCenter, status: e.status,
  };
  const decision = await awaitApproval({
    id: `packet:${employeeId}`, workflowId: wf.workflowInfo().workflowId,
    kind: "packet-assignment", title: `Assign ${rec.packetId}`, detail,
    createdAt: new Date().toISOString(), status: "pending",
  }, { timeout: "7 days" });                                                              // human confirm (UC6)
  if (!decision?.approved) {
    await alarmDidNotSend({ employeeId, template: "packet-assignment", reason: decision ? "rejected" : "expired" });
    return;
  }
  const docs = decision.selectedDocs?.length ? decision.selectedDocs : packet.requiredDocs;   // reviewer subset, else whole packet
  await assignPacket(companyId, employeeId, rec.packetId, docs);                              // robot write → file drop
  await sendEmail({                                                                           // email the chosen docs to the hire
    to: e.email, templateAlias: TEMPLATE.ONBOARDING_PACKET,
    model: { firstName: e.firstName, packetId: rec.packetId, docs: docs.join(", ") },
    idempotencyKey: `packet-email:${employeeId}`,
  });
}
