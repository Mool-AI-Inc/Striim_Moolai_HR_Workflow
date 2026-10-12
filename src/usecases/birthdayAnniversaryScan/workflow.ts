/**
 * UC5 workflow — daily birthday/anniversary scan: list → select → send.
 * @lifespan PRODUCTION
 * @responsibility List today's roster, pick today's celebrants (selectors.ts), send one ledgered,
 *   template-keyed email per hit via the shared sendEmail activity.
 */
import { proxyActivities } from "@temporalio/workflow";
import type { EmployeeRecord, TransactionalEmail } from "../../platform/domain/types.js";
import { TEMPLATE } from "../../platform/domain/types.js";
import { whoCelebratesOn } from "./selectors.js";

const { listEmployees, sendEmail } = proxyActivities<{
  listEmployees(companyId: string): Promise<EmployeeRecord[]>;
  sendEmail(email: TransactionalEmail): Promise<{ messageId: string; skipped?: false } | { skipped: true }>;
}>({ startToCloseTimeout: "30 seconds" });

export interface BirthdayAnniversaryScanInput { companyId: string; todayISO: string; }

export async function birthdayAnniversaryScan(input: BirthdayAnniversaryScanInput): Promise<void> {
  const employees = await listEmployees(input.companyId);
  const hits = whoCelebratesOn(input.todayISO, employees);
  const year = input.todayISO.slice(0, 4);
  for (const hit of hits) {
    const templateAlias = hit.occasion === "birthday" ? TEMPLATE.BIRTHDAY : TEMPLATE.ANNIVERSARY;
    await sendEmail({
      to: hit.employee.email,
      templateAlias,
      model: { firstName: hit.employee.firstName, lastName: hit.employee.lastName },
      idempotencyKey: `${hit.occasion}:${hit.employee.employeeId}:${year}`,
    });
  }
}
