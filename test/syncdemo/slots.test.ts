/**
 * Slot allocation: the guarantees the brief asks for, asserted against a real Postgres.
 *
 *   npm run syncdemo:test
 *
 * Every property here is enforced by the database rather than by application bookkeeping, so
 * these tests exercise the constraint, not a mock of it. Skips without a database, as the rest of
 * this suite does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { faults } from "../../src/syncdemo/server/adapters/types.js";

const DB = process.env.SYNCDEMO_TEST_DATABASE_URL
        ?? process.env.SYNCDEMO_DATABASE_URL
        ?? process.env.LEDGER_DATABASE_URL;

const POOL = ["EMP_9001", "EMP_9002", "EMP_9003", "EMP_9004", "EMP_9005"];

describe.skipIf(!DB)("slot allocation", () => {
  let db: typeof import("../../src/syncdemo/server/db.js");
  let slots: typeof import("../../src/syncdemo/server/slots.js");

  beforeAll(async () => {
    process.env.SYNCDEMO_DATABASE_URL = DB;
    process.env.SYNCDEMO_MODE = "mock";
    // A small pool, so exhaustion is reachable in a test rather than needing twenty employees.
    process.env.ADAPTIVE_DEMO_SLOTS = POOL.join(",");
    expect(process.env.SYNCDEMO_SCHEMA, "run via `npm run syncdemo:test`").toBe("syncdemo_test");
    db = await import("../../src/syncdemo/server/db.js");
    slots = await import("../../src/syncdemo/server/slots.js");
    await db.migrate(DB!);
  });

  afterAll(async () => { await db.closePool(); });

  beforeEach(async () => {
    faults.postgresDown = false; faults.workdayFail = false; faults.striimStall = false;
    await db.resetDemo();
  });

  it("hands out the lowest free slot, in configured order", async () => {
    expect((await slots.claimSlot("EMP-1001", "Sarah Smith")).mapping.slot).toBe("EMP_9001");
    expect((await slots.claimSlot("EMP-1002", "John Davis")).mapping.slot).toBe("EMP_9002");
    expect((await slots.claimSlot("EMP-1003", "Priya Kumar")).mapping.slot).toBe("EMP_9003");
  });

  it("is idempotent — the same employee never takes a second slot", async () => {
    const first = await slots.claimSlot("EMP-1001", "Sarah Smith");
    expect(first.fresh).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      const again = await slots.claimSlot("EMP-1001", "Sarah Smith");
      expect(again.mapping.slot).toBe("EMP_9001");
      expect(again.fresh).toBe(false);
    }
    const monitor = await slots.slotMonitor();
    expect(monitor.summary.AVAILABLE).toBe(POOL.length - 1);
  });

  it("survives a restart — the mapping is in Postgres, not memory", async () => {
    await slots.claimSlot("EMP-1001", "Sarah Smith");
    await db.closePool();                       // drop every connection, as a restart would
    db.getPool(DB!);                            // reconnect
    const after = await slots.mappingFor("EMP-1001");
    expect(after?.slot).toBe("EMP_9001");
  });

  it("refuses to allocate outside the configured pool", async () => {
    for (const [i, id] of ["a", "b", "c", "d", "e"].entries()) {
      const { mapping } = await slots.claimSlot(id, `Person ${i}`);
      expect(POOL).toContain(mapping.slot);
    }
  });

  it("stops gracefully when the pool is exhausted, rather than reusing a member", async () => {
    for (const [i] of POOL.entries()) await slots.claimSlot(`EMP-20${i}`, `Person ${i}`);
    expect((await slots.slotMonitor()).summary.AVAILABLE).toBe(0);

    await expect(slots.claimSlot("EMP-9999", "One Too Many"))
      .rejects.toThrow(/No available Workday\/Adaptive demo slots/);
    // The operator-facing sentence the brief specifies.
    await expect(slots.claimSlot("EMP-9999", "One Too Many"))
      .rejects.toThrow(/Please add additional slots before processing another employee/);
  });

  it("keeps a failed slot claimed by its employee so a retry reuses the same member", async () => {
    const { mapping } = await slots.claimSlot("EMP-1001", "Sarah Smith");
    await slots.setMappingStatus("EMP-1001", "FAILED", "Adaptive rejected it");

    // A different employee must NOT be handed the failed slot.
    expect((await slots.claimSlot("EMP-1002", "John Davis")).mapping.slot).toBe("EMP_9002");
    // And the original keeps it.
    expect((await slots.claimSlot("EMP-1001", "Sarah Smith")).mapping.slot).toBe(mapping.slot);
    const monitor = await slots.slotMonitor();
    expect(monitor.summary.FAILED).toBe(1);
  });

  it("reports the whole pool, with unclaimed members AVAILABLE", async () => {
    await slots.claimSlot("EMP-1001", "Sarah Smith");
    await slots.setMappingStatus("EMP-1001", "SYNCED", "written");
    const { slots: rows, summary } = await slots.slotMonitor();
    expect(rows).toHaveLength(POOL.length);
    expect(rows[0]).toMatchObject({ slot: "EMP_9001", status: "SYNCED", employeeName: "Sarah Smith" });
    expect(rows[1]).toMatchObject({ slot: "EMP_9002", status: "AVAILABLE" });
    expect(summary.SYNCED).toBe(1);
    expect(summary.AVAILABLE).toBe(POOL.length - 1);
  });

  it("does not hand the same slot to two employees under concurrency", async () => {
    // Fired together on one pool, so the claims genuinely interleave.
    const results = await Promise.all(
      ["c1", "c2", "c3", "c4", "c5"].map((id) => slots.claimSlot(id, id)));
    const assigned = results.map((r) => r.mapping.slot);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned.every((s) => POOL.includes(s))).toBe(true);
  });
});

describe.skipIf(!DB)("five employees end to end, each into its own slot", () => {
  let db: typeof import("../../src/syncdemo/server/db.js");
  let slots: typeof import("../../src/syncdemo/server/slots.js");
  let pipeline: import("../../src/syncdemo/server/pipeline.js").Pipeline;

  const people = [
    { employeeId: "EMP-1001", firstName: "Sarah", lastName: "Smith", email: "sarah@example.com", payRate: 100000 },
    { employeeId: "EMP-1002", firstName: "John", lastName: "Davis", email: "john@example.com", payRate: 90000 },
    { employeeId: "EMP-1003", firstName: "Priya", lastName: "Kumar", email: "priya@example.com", payRate: 120000 },
    { employeeId: "EMP-1004", firstName: "Tom", lastName: "Reilly", email: "tom@example.com", payRate: 80000 },
    { employeeId: "EMP-1005", firstName: "Ana", lastName: "Reyes", email: "ana@example.com", payRate: 110000 },
  ];

  beforeAll(async () => {
    process.env.SYNCDEMO_DATABASE_URL = DB;
    process.env.SYNCDEMO_MODE = "mock";
    process.env.ADAPTIVE_DEMO_SLOTS = POOL.join(",");
    db = await import("../../src/syncdemo/server/db.js");
    slots = await import("../../src/syncdemo/server/slots.js");
    const { Pipeline } = await import("../../src/syncdemo/server/pipeline.js");
    const { loadConfig } = await import("../../src/syncdemo/server/config.js");
    await db.migrate(DB!);
    pipeline = new Pipeline(loadConfig());
  });

  afterAll(async () => { await db.closePool(); });

  it("allocates EMP_9001..EMP_9005 in arrival order, carrying the real pay figure", async () => {
    faults.postgresDown = false; faults.workdayFail = false; faults.striimStall = false;
    await db.resetDemo();

    for (const p of people) {
      await pipeline.createEmployee(p);
      await pipeline.integration.pollNow();
    }

    for (const [i, p] of people.entries()) {
      const stages = await db.stagesFor(p.employeeId);
      expect(stages.map((s) => s.status), p.employeeId).toEqual(["synced", "synced", "synced", "synced"]);
      const mapping = await slots.mappingFor(p.employeeId);
      expect(mapping?.slot, p.employeeId).toBe(POOL[i]);
      expect(mapping?.status).toBe("SYNCED");
      // The pay figure came from the create call and survived the whole pipeline.
      expect((await db.getEmployee(p.employeeId))?.payRate).toBe(p.payRate);
    }

    const monitor = await slots.slotMonitor();
    expect(monitor.summary.SYNCED).toBe(5);
    expect(monitor.summary.AVAILABLE).toBe(0);

    // Re-processing everyone must not consume a sixth slot — there isn't one.
    for (const p of people) await pipeline.createEmployee(p);
    await pipeline.integration.pollNow();
    expect((await slots.slotMonitor()).summary.SYNCED).toBe(5);
    expect(await db.employeeCount()).toBe(5);
    // 120s, not the project default of 30s. Ten creates and six polls against a remote Neon
    // database is a few hundred round trips, and the latency — not the work — is what blows the
    // budget. Raising it here rather than globally keeps the fast tests fast.
  }, 120_000);
});
