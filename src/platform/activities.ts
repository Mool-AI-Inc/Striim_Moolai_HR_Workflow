/**
 * Shared Temporal activities — the platform-owned side effects every module can call by name.
 * @lifespan PRODUCTION — the six reserved shared activities: sendEmail, getEmployee, listEmployees,
 *   alarmDidNotSend, registerPending, resolvePending. Activity names are a flat global namespace — modules
 *   must not shadow these (the worker throws on a collision, spec §F3).
 * @responsibility Build the real connectors ONCE from env (simulator in demo, real vendors in live) and expose
 *   the shared activities; sendEmail is ledgered + idempotent.
 */
import type { EmployeeRecord, TransactionalEmail, PendingApproval } from "./domain/types.js";
import { loadEnv } from "./config/env.js";
import { PaylocityConnector } from "./connectors/paylocity/paylocityConnector.js";
import { PostmarkCommsConnector } from "./connectors/comms/postmarkCommsConnector.js";
import { recordSend, alreadySent } from "./db/sendLedger.js";
import { emitDidNotSendAlarm } from "./observability/alarms.js";
import { upsertPending, setStatus } from "./db/approvals.js";

const env = loadEnv();
const hris = new PaylocityConnector(env.paylocity);
const comms = new PostmarkCommsConnector(env.postmark);

/** Ledgered, idempotent send: skip if already sent, else send + record; on failure record 'failed' and rethrow. */
export async function sendEmail(email: TransactionalEmail): Promise<{ messageId: string; skipped?: false } | { skipped: true }> {
  if (await alreadySent(email.idempotencyKey)) return { skipped: true };
  try {
    const receipt = await comms.sendTransactional(email);
    await recordSend({ idempotencyKey: email.idempotencyKey, to: email.to, template: email.templateAlias, status: "sent", messageId: receipt.messageId });
    return { messageId: receipt.messageId };
  } catch (e) {
    await recordSend({ idempotencyKey: email.idempotencyKey, to: email.to, template: email.templateAlias, status: "failed" });
    throw e;
  }
}

export async function getEmployee(companyId: string, employeeId: string): Promise<EmployeeRecord> {
  return hris.getEmployee(companyId, employeeId);
}

export async function listEmployees(companyId: string): Promise<EmployeeRecord[]> {
  return hris.listEmployees(companyId);
}

/** template is a free-form string (spec §B5) — HITL callers pass PendingApproval.kind values, not only aliases. */
export async function alarmDidNotSend(a: { employeeId: string; template: string; reason: string }): Promise<void> {
  await emitDidNotSendAlarm(a);
}

export async function registerPending(p: PendingApproval): Promise<void> {
  await upsertPending(p);
}

export async function resolvePending(id: string, status: PendingApproval["status"]): Promise<void> {
  await setStatus(id, status);
}
