import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { alarmDidNotSend } from "../../src/platform/activities.js";
import { migrate } from "../../src/platform/db/sendLedger.js";
import { getPool, closePool } from "../../src/platform/db/pool.js";

// Needs compose Postgres (the alarm writes a status='alarm' ledger row).
describe("did-not-send alarm", () => {
  beforeAll(async () => { await migrate(); });
  afterAll(async () => { await closePool(); });

  it("logs a structured error and writes a status='alarm' ledger row", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await alarmDidNotSend({ employeeId: "E-ALARM", template: "day60-compliance", reason: "boom" });
    expect(spy).toHaveBeenCalled();
    const logged = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(logged).toMatchObject({ alarm: "did-not-send", employeeId: "E-ALARM", template: "day60-compliance", reason: "boom" });
    spy.mockRestore();
    const r = await getPool().query(`SELECT count(*)::int AS n FROM send_ledger WHERE status='alarm' AND template='day60-compliance' AND "to"='E-ALARM'`);
    expect(r.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});
