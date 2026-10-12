import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate, recordSend, alreadySent, recordOptOut, isOptedOut } from "../../src/platform/db/sendLedger.js";
import { getPool, closePool } from "../../src/platform/db/pool.js";

// Integration tier — needs compose Postgres: docker compose --profile runtime up -d app-postgres
describe("send ledger (integration)", () => {
  beforeAll(async () => {
    await migrate();
    await getPool().query(`TRUNCATE send_ledger, sms_opt_out`);
  });
  afterAll(async () => { await closePool(); });

  it("recordSend is idempotent by key; alreadySent reflects it; exactly one row", async () => {
    const key = "led-k1";
    await recordSend({ idempotencyKey: key, to: "e@instantteams.test", template: "welcome", status: "sent", messageId: "m1" });
    await recordSend({ idempotencyKey: key, to: "e@instantteams.test", template: "welcome", status: "sent", messageId: "m2" });
    expect(await alreadySent(key)).toBe(true);
    const r = await getPool().query(`SELECT count(*)::int AS n FROM send_ledger WHERE idempotency_key = $1`, [key]);
    expect(r.rows[0].n).toBe(1);
  });

  it("recordOptOut / isOptedOut", async () => {
    await recordOptOut("+15551230000");
    expect(await isOptedOut("+15551230000")).toBe(true);
    expect(await isOptedOut("+19999999999")).toBe(false);
  });
});
