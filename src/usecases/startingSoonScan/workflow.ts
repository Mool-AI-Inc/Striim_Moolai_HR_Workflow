/**
 * UC8 workflow — daily "starts tomorrow" scan: list → select → invite to Slack.
 * @lifespan PRODUCTION
 * @responsibility List today's roster, pick tomorrow's starters (selectors.ts), invite each to their role
 *   channels via the module-owned inviteToSlack activity. Safe to re-run: inviteToSlack is idempotent.
 */
import { proxyActivities } from "@temporalio/workflow";
import type { EmployeeRecord } from "../../platform/domain/types.js";
import { whoStartsTomorrow } from "./selectors.js";

const { listEmployees, inviteToSlack } = proxyActivities<{
  listEmployees(companyId: string): Promise<EmployeeRecord[]>;
  inviteToSlack(employee: EmployeeRecord): Promise<{ invited: boolean; alreadyMember: boolean }>;
}>({ startToCloseTimeout: "30 seconds" });

export interface StartingSoonScanInput { companyId: string; todayISO: string; }

export async function startingSoonScan(input: StartingSoonScanInput): Promise<void> {
  const employees = await listEmployees(input.companyId);
  const hits = whoStartsTomorrow(input.todayISO, employees);
  for (const employee of hits) {
    await inviteToSlack(employee);
  }
}
