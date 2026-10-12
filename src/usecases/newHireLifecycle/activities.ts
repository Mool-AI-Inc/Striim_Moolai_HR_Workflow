/**
 * newHireLifecycle activities — the module-owned side effects (UC7 sendSms).
 * @lifespan PRODUCTION — the real SMS send path; consent is gated in the workflow, STOP in this activity.
 * @responsibility Build the SMS connector from env; skip a send to an opted-out number.
 */
import { loadEnv } from "../../platform/config/env.js";
import { isOptedOut } from "../../platform/db/sendLedger.js";
import { AcSmsConnector } from "./connectors/acSmsConnector.js";
import type { SmsMessage } from "../../platform/domain/types.js";

const env = loadEnv();
const sms = new AcSmsConnector({ baseUrl: env.sms.baseUrl, apiToken: env.sms.token });

/** STOP-gated send (consent is checked in the workflow, which holds the employee record). */
export async function sendSms(msg: SmsMessage): Promise<{ messageId: string } | { skipped: true }> {
  if (await isOptedOut(msg.to)) return { skipped: true };
  return sms.sendSms(msg);
}
