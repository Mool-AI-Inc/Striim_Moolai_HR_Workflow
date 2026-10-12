/**
 * UC3 workflow — personnel file: gather background-check + I-9 → file only what arrived → checklist →
 *   human approval → finalize (Paylocity staging) on approve, alarm + stop on reject/expire.
 * @lifespan PRODUCTION
 * @responsibility Fetch the background-check (Vetty) and I-9 (WorkBright) docs when their ids are present,
 *   putFile ONLY the docs that actually arrived (never half-file — a missing doc is reported by the checklist,
 *   not filed as a placeholder), buildChecklist, park on awaitApproval as the personnel-file gate, and on
 *   approve call the shared PaylocityConnector.createEmployeeStaging via a module activity. On reject/expire,
 *   fire alarmDidNotSend and stop — no staging call. PII guardrail: the only Drive call anywhere in this
 *   workflow is putFile (fileDocument) — no sharing/permission call exists to make.
 *
 * createEmployeeStaging gets its own proxy with a bounded retry (maximumAttempts: 3), same reasoning as
 * enBenefitsSend's stageSend / packetSelection's assignPacket: the platform's default retry policy is
 * effectively unlimited, which would retry a persistent post-approval failure forever and the alarm below
 * would never fire — a human approved this and it must not just silently never happen.
 */
import { proxyActivities, workflowInfo, log } from "@temporalio/workflow";
import type { EmployeeRecord, ScreeningDoc, PersonnelChecklist, PendingApproval } from "../../platform/domain/types.js";
import { awaitApproval } from "../../platform/approvals.js";
import { buildChecklist, REQUIRED_DOCS } from "./selectors.js";

const { getEmployee, alarmDidNotSend } = proxyActivities<{
  getEmployee(companyId: string, employeeId: string): Promise<EmployeeRecord>;
  alarmDidNotSend(a: { employeeId: string; template: string; reason: string }): Promise<void>;
}>({ startToCloseTimeout: "30 seconds" });

const { fetchBackgroundCheck, fetchI9, fileDocument } = proxyActivities<{
  fetchBackgroundCheck(screeningId: string): Promise<ScreeningDoc>;
  fetchI9(submissionId: string): Promise<ScreeningDoc>;
  fileDocument(folderId: string, doc: ScreeningDoc): Promise<{ fileId: string }>;
}>({ startToCloseTimeout: "30 seconds" });

const { createEmployeeStaging } = proxyActivities<{
  createEmployeeStaging(companyId: string, employee: EmployeeRecord): Promise<{ employeeId: string }>;
}>({ startToCloseTimeout: "30 seconds", retry: { maximumAttempts: 3 } });

// screeningId/submissionId are optional: absent means the doc hasn't been submitted to Vetty/WorkBright yet —
// don't call the connector for it, just report it missing on the checklist (never guess/half-file it).
export interface PersonnelFileInput {
  companyId: string; employeeId: string; screeningId?: string; submissionId?: string; folderId: string;
}

export async function personnelFile(input: PersonnelFileInput): Promise<void> {
  const arrived: string[] = [];

  if (input.screeningId) {
    const doc = await fetchBackgroundCheck(input.screeningId);
    await fileDocument(input.folderId, doc);
    arrived.push("background-check");
  }
  if (input.submissionId) {
    const doc = await fetchI9(input.submissionId);
    await fileDocument(input.folderId, doc);
    arrived.push("i-9");
  }

  const checklist: PersonnelChecklist = buildChecklist(REQUIRED_DOCS, arrived, input.employeeId);

  const pending: PendingApproval = {
    id: workflowInfo().workflowId,
    workflowId: workflowInfo().workflowId,
    kind: "personnel-file",
    title: `Personnel file — ${input.employeeId}`,
    detail: checklist,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  const decision = await awaitApproval(pending, { timeout: "7 days" });

  if (decision?.approved) {
    log.info("personnel file approved — finalizing Paylocity staging", { employeeId: input.employeeId, approver: decision.approver });
    const employee = await getEmployee(input.companyId, input.employeeId);
    try {
      await createEmployeeStaging(input.companyId, employee);
    } catch (e) {
      await alarmDidNotSend({ employeeId: input.employeeId, template: "personnel-file", reason: (e as Error).message });
    }
    return;
  }

  await alarmDidNotSend({
    employeeId: input.employeeId,
    template: "personnel-file",
    reason: decision ? `rejected by ${decision.approver}: ${decision.reason}` : "personnel-file approval window expired",
  });
}
