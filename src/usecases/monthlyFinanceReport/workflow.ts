/**
 * UC4 workflow — monthly finance report: list → filter to this month's hires → flag cost-center
 *   transitions → write via the report sink → notify Finance (Taylor) → await the human release ack.
 * @lifespan PRODUCTION
 * @responsibility Build this month's new-hire report, highlight cost-center transitions, notify Taylor via
 *   the shared sendEmail activity, then park on awaitApproval as the release-acknowledgment audit record.
 *   Automation never grants sharing/permissions here — report release (Finance access) is a human action
 *   outside the system; this workflow has no permission-granting call available to make.
 */
import { proxyActivities, workflowInfo } from "@temporalio/workflow";
import type { EmployeeRecord, TransactionalEmail, FinanceReportRow, PendingApproval } from "../../platform/domain/types.js";
import { TEMPLATE } from "../../platform/domain/types.js";
import { awaitApproval } from "../../platform/approvals.js";
import { flagTransitions } from "./selectors.js";
import type { UnflaggedRow } from "./selectors.js";

const { listEmployees, sendEmail, writeFinanceReport } = proxyActivities<{
  listEmployees(companyId: string): Promise<EmployeeRecord[]>;
  sendEmail(email: TransactionalEmail): Promise<{ messageId: string; skipped?: false } | { skipped: true }>;
  writeFinanceReport(name: string, rows: FinanceReportRow[]): Promise<{ location: string }>;
}>({ startToCloseTimeout: "30 seconds" });

const TAYLOR_EMAIL = "taylor@instantteams.test"; // Finance recipient of the monthly report

export interface MonthlyFinanceReportInput { companyId: string; monthISO: string; } // monthISO = "YYYY-MM"

export async function monthlyFinanceReport(input: MonthlyFinanceReportInput): Promise<void> {
  const employees = await listEmployees(input.companyId);
  const hires = employees.filter((e) => e.hireDate.slice(0, 7) === input.monthISO);
  const unflagged: UnflaggedRow[] = hires.map((e) => ({
    employeeId: e.employeeId,
    name: `${e.firstName} ${e.lastName}`,
    costCenter: e.costCenter,
    priorCostCenter: e.priorCostCenter,
    hireDate: e.hireDate,
  }));
  const rows = flagTransitions(unflagged);
  const reportName = `finance-report-${input.monthISO}`;
  const { location } = await writeFinanceReport(reportName, rows);
  const transitionCount = rows.filter((r) => r.isTransition).length;

  await sendEmail({
    to: TAYLOR_EMAIL,
    templateAlias: TEMPLATE.UC4_REPORT_READY,
    model: { month: input.monthISO, location, transitionCount: String(transitionCount) },
    idempotencyKey: `uc4-report-ready:${input.monthISO}`,
  });

  const pending: PendingApproval = {
    id: workflowInfo().workflowId,
    workflowId: workflowInfo().workflowId,
    kind: "finance-report",
    title: `Monthly finance report — ${input.monthISO}`,
    detail: { location, rowCount: rows.length, transitionCount },
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  // Audit-only acknowledgment: awaitApproval records who released the report and when. It never grants
  // Drive/Sheets access — DriveConnector exposes only putFile (no setPermissions exists anywhere in the
  // platform), so there is literally no sharing/permission call this workflow could make.
  await awaitApproval(pending, { timeout: "14 days" });
}
