/**
 * newHireLifecycle — UC1 welcome + UC2a hire-anchored Day-60 compliance notice.
 * @lifespan PRODUCTION — the real orchestration; unchanged at cutover.
 * @responsibility Send the welcome now, then durably wait to Day-60 and send the compliance notice.
 */
import * as wf from "@temporalio/workflow";
import type { EmployeeRecord, TransactionalEmail, SmsMessage } from "../../platform/domain/types.js";
import { TEMPLATE } from "../../platform/domain/types.js";

const { getEmployee, sendEmail, sendSms, alarmDidNotSend } = wf.proxyActivities<{
  getEmployee(companyId: string, employeeId: string): Promise<EmployeeRecord>;
  sendEmail(email: TransactionalEmail): Promise<{ messageId: string }>;
  sendSms(msg: SmsMessage): Promise<{ messageId: string } | { skipped: true }>;
  alarmDidNotSend(a: { employeeId: string; template: string; reason: string }): Promise<void>;
}>({ startToCloseTimeout: "1 minute", retry: { initialInterval: "2s", backoffCoefficient: 2, maximumAttempts: 5, nonRetryableErrorTypes: ["PostmarkPermanentError"] } });

const DAY = 864e5;

export async function newHireLifecycle(input: { companyId: string; employeeId: string }): Promise<void> {
  const e = await getEmployee(input.companyId, input.employeeId);
  const model = { firstName: e.firstName, lastName: e.lastName };
  await sendEmail({ to: e.email, templateAlias: TEMPLATE.WELCOME, model, idempotencyKey: `welcome:${e.employeeId}` });   // UC1
  if (e.smsConsent) {                                                                                                    // UC7 — consent-gated
    await sendSms({ to: e.phone, body: TEMPLATE.WELCOME_SMS, idempotencyKey: `welcome-sms:${e.employeeId}` });
  }
  // UC2a — anchor Day-60 to the HIRE date, not to event receipt.
  const day60 = new Date(e.hireDate).getTime() + 60 * DAY;
  await wf.sleep(Math.max(0, day60 - Date.now()));                                                                       // durable, hire-anchored
  try {
    await sendEmail({ to: e.email, templateAlias: TEMPLATE.DAY60_COMPLIANCE, model, idempotencyKey: `day60:${e.employeeId}` });
  } catch (err) {
    await alarmDidNotSend({ employeeId: e.employeeId, template: TEMPLATE.DAY60_COMPLIANCE, reason: String(err) });       // did-not-send backstop
  }
  // UC2b — hand off the Day-60 EN send as a detached child, BY NAME (no sibling import).
  await wf.startChild("benefitsDay60Send", {
    workflowId: `benefits60:${e.employeeId}`,
    args: [{ companyId: input.companyId, employeeId: e.employeeId }],
    parentClosePolicy: wf.ParentClosePolicy.ABANDON,
  });
}
