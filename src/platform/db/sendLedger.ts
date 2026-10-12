/**
 * Send ledger — append-only record of every send + the SMS opt-out list.
 * @lifespan PRODUCTION — every send is ledgered; alreadySent is the idempotency gate; UC7 uses the opt-out helpers.
 * @responsibility Idempotent recordSend (ON CONFLICT DO NOTHING), the alreadySent gate, the opt-out set.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getPool } from "./pool.js";

export interface LedgerEntry { idempotencyKey: string; to: string; template: string; status: string; messageId?: string; }

const SCHEMA = new URL("./schema.sql", import.meta.url);

export async function migrate(): Promise<void> {
  await getPool().query(readFileSync(fileURLToPath(SCHEMA), "utf8"));
}

export async function recordSend(e: LedgerEntry): Promise<void> {
  await getPool().query(
    `INSERT INTO send_ledger (idempotency_key, "to", template, status, message_id)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (idempotency_key) DO NOTHING`,
    [e.idempotencyKey, e.to, e.template, e.status, e.messageId ?? null],
  );
}

export async function alreadySent(key: string): Promise<boolean> {
  const r = await getPool().query(`SELECT 1 FROM send_ledger WHERE idempotency_key = $1 AND status = 'sent'`, [key]);
  return (r.rowCount ?? 0) > 0;
}

export async function recordOptOut(phone: string): Promise<void> {
  await getPool().query(`INSERT INTO sms_opt_out (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING`, [phone]);
}

export async function isOptedOut(phone: string): Promise<boolean> {
  const r = await getPool().query(`SELECT 1 FROM sms_opt_out WHERE phone = $1`, [phone]);
  return (r.rowCount ?? 0) > 0;
}
