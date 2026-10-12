/**
 * Did-not-send alarm — the loud signal when a legally-required notice (e.g. the Day-60 notice) fails to send.
 * @lifespan PRODUCTION — the compliance backstop; a structured error log + an append-only 'alarm' ledger row.
 * @responsibility emitDidNotSendAlarm: log structured JSON and write a status='alarm' row keyed uniquely.
 */
import { recordSend } from "../db/sendLedger.js";

export interface DidNotSendAlarm { employeeId: string; template: string; reason: string; }

export async function emitDidNotSendAlarm(a: DidNotSendAlarm): Promise<void> {
  console.error(JSON.stringify({ alarm: "did-not-send", ...a, at: new Date().toISOString() }));
  await recordSend({
    idempotencyKey: `alarm:${a.employeeId}:${a.template}:${Date.now()}`,  // unique per firing; alarms are not deduped
    to: a.employeeId, template: a.template, status: "alarm",
  });
}
