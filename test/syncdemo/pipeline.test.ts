/**
 * Tests for the critical synchronisation path.
 *
 * These run against a real Postgres, because every guarantee worth testing here is enforced by
 * the database: the idempotency claim is an INSERT .. ON CONFLICT, the unique email index is what
 * stops a duplicate person, and the stage state the dashboard renders is a table. Stubbing
 * Postgres out would leave the tests asserting the behaviour of a mock rather than the behaviour
 * of the system.
 *
 *   SYNCDEMO_TEST_DATABASE_URL=postgres://...  npx vitest run --project syncdemo
 *
 * With no database configured the suite skips rather than fails, so `npm test` stays green on a
 * machine with no Postgres. A skip is honest; a pass with nothing exercised is not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { faults } from "../../src/syncdemo/server/adapters/types.js";
import { transform } from "../../src/syncdemo/server/adapters/striim.js";
import { validate, ValidationError } from "../../src/syncdemo/server/pipeline.js";

const DB = process.env.SYNCDEMO_TEST_DATABASE_URL
        ?? process.env.SYNCDEMO_DATABASE_URL
        ?? process.env.LEDGER_DATABASE_URL;

// ── pure units, no database needed ────────────────────────────────────────────────────────

describe("validate", () => {
  const good = { employeeId: "EMP-1001", firstName: "Sarah", lastName: "Smith", email: "sarah@example.com" };

  it("accepts the acceptance-test record", () => {
    const out = validate({ ...good, jobTitle: "Forward Deployed Engineer", department: "Engineering", location: "San Francisco" });
    expect(out.employeeId).toBe("EMP-1001");
    expect(out.jobTitle).toBe("Forward Deployed Engineer");
  });

  it("lower-cases email so the unique index cannot be defeated by capitalisation", () => {
    expect(validate({ ...good, email: "Sarah@Example.COM" }).email).toBe("sarah@example.com");
  });

  it("drops blank optional fields rather than storing empty strings", () => {
    const out = validate({ ...good, jobTitle: "   ", department: "" });
    expect(out.jobTitle).toBeUndefined();
    expect(out.department).toBeUndefined();
  });

  it.each([
    [{ ...good, employeeId: "" }, "Employee ID is required"],
    [{ ...good, employeeId: "a" }, "2-64 characters"],
    [{ ...good, employeeId: "bad id!" }, "2-64 characters"],
    [{ ...good, email: "nope" }, "not a valid email"],
    [{ ...good, firstName: " " }, "First name is required"],
    [{ ...good, hireDate: "01/02/2026" }, "YYYY-MM-DD"],
  ])("rejects %o", (input, fragment) => {
    expect(() => validate(input)).toThrow(ValidationError);
    expect(() => validate(input)).toThrow(new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("transform", () => {
  it("is the step the dashboard claims it is: trims, lower-cases, stamps provenance", () => {
    const out = transform({
      employeeId: " EMP-1 ", firstName: " Sarah ", lastName: " Smith ",
      email: " Sarah@Example.com ", department: "  ", location: "San Francisco",
    });
    expect(out).toMatchObject({
      employeeId: "EMP-1", firstName: "Sarah", lastName: "Smith",
      email: "sarah@example.com", location: "San Francisco", sourceSystem: "bamboohr",
    });
    expect(out.department).toBeUndefined();
  });
});

// ── the pipeline, against a real database ─────────────────────────────────────────────────

describe.skipIf(!DB)("pipeline end to end (mock adapters, real Postgres)", () => {
  let pipeline: import("../../src/syncdemo/server/pipeline.js").Pipeline;
  let db: typeof import("../../src/syncdemo/server/db.js");

  const record = {
    employeeId: "EMP-TEST-1", firstName: "Sarah", lastName: "Smith",
    email: "sarah.test@example.com", jobTitle: "Forward Deployed Engineer",
    department: "Engineering", location: "San Francisco",
  };

  /** Drive the poller by hand so the tests are deterministic rather than time-dependent. */
  const settle = async () => { await pipeline.integration.pollNow(); };

  beforeAll(async () => {
    process.env.SYNCDEMO_DATABASE_URL = DB;
    process.env.SYNCDEMO_MODE = "mock";
    // SYNCDEMO_SCHEMA is NOT set here. It cannot be: db.ts reads it once at module-evaluation
    // time and this file's static imports have already pulled db.ts in by the time any hook runs.
    // It is set by the `syncdemo` project's `env` in vitest.config.ts, which applies before any
    // module loads. Assert it, so a future config change cannot silently point the suite at the
    // schema a running dev server owns — the symptom of that is failures that move between runs.
    expect(process.env.SYNCDEMO_SCHEMA, "run via `npm run syncdemo:test`").toBe("syncdemo_test");
    db = await import("../../src/syncdemo/server/db.js");
    expect(db.schemaName).toBe("syncdemo_test");
    const { Pipeline } = await import("../../src/syncdemo/server/pipeline.js");
    const { loadConfig } = await import("../../src/syncdemo/server/config.js");
    await db.migrate(DB!);
    // Deliberately NOT started: an interval racing the assertions is the classic way these tests
    // become flaky. pollNow() gives the same code path under the test's control.
    pipeline = new Pipeline(loadConfig());
  });

  afterAll(async () => { await db.closePool(); });

  beforeEach(async () => {
    faults.postgresDown = false;
    faults.workdayFail = false;
    faults.striimStall = false;
    await db.resetDemo();
  });

  it("moves an employee through all four stages", async () => {
    await pipeline.createEmployee(record);

    // After the create, ONLY the source stage is done. This is the assertion that the create call
    // does not secretly push the record downstream.
    let stages = await db.stagesFor(record.employeeId);
    expect(stages.find((s) => s.stage === "bamboohr")?.status).toBe("synced");
    expect(stages.find((s) => s.stage === "striim")?.status).toBe("pending");
    expect(await db.employeeCount()).toBe(0);

    await settle();

    stages = await db.stagesFor(record.employeeId);
    expect(stages.map((s) => s.status)).toEqual(["synced", "synced", "synced", "synced"]);

    const row = await db.getEmployee(record.employeeId);
    expect(row).toMatchObject({
      firstName: "Sarah", lastName: "Smith", email: "sarah.test@example.com",
      department: "Engineering", sourceSystem: "bamboohr", syncStatus: "synced",
    });

    const worker = await db.mockWorkdayGet(record.employeeId);
    expect(worker?.legal_name).toBe("Sarah Smith");
    // The destination identity is the pre-allocated Adaptive member, not a generated WD- id.
    // It used to be `WD-<uuid>`; now the slot the allocator claimed IS the worker id, because the
    // member is the thing that exists in the target system and a made-up id would correspond to
    // nothing. The BambooHR id stays the correlation key.
    expect(String(worker?.worker_id)).toMatch(/^EMP_9/);
    expect(worker?.employee_id).toBe(record.employeeId);
  });

  it("keeps the employee_id identical across all four systems", async () => {
    await pipeline.createEmployee(record);
    await settle();
    const landing = await db.getLanding(record.employeeId);
    const pg = await db.getEmployee(record.employeeId);
    const wd = await db.mockWorkdayGet(record.employeeId);
    expect(landing?.payload.employeeId).toBe(record.employeeId);
    expect(pg?.employeeId).toBe(record.employeeId);
    expect(wd?.employee_id).toBe(record.employeeId);
  });

  it("is idempotent: creating and polling repeatedly yields one employee and one worker", async () => {
    await pipeline.createEmployee(record);
    await settle();
    // Re-create the same person, then poll several more times. A polling pipeline redelivers; the
    // watermark advances only after a successful land, so this is the normal case, not an edge.
    await pipeline.createEmployee(record);
    await settle();
    await settle();
    await settle();

    expect(await db.employeeCount()).toBe(1);
    expect(await db.mockWorkdayCount()).toBe(1);
    expect(await db.mockBambooCount()).toBe(1);
  });

  it("refuses a second employee_id that reuses an existing email", async () => {
    await pipeline.createEmployee(record);
    await expect(pipeline.createEmployee({ ...record, employeeId: "EMP-TEST-2" }))
      .rejects.toThrow(/already belongs to/);
    expect(await db.mockBambooCount()).toBe(1);
  });

  it("stops at PostgreSQL when the write fails, and leaves Workday untouched", async () => {
    faults.postgresDown = true;
    await pipeline.createEmployee(record);
    await settle();

    const stages = await db.stagesFor(record.employeeId);
    expect(stages.find((s) => s.stage === "striim")?.status).toBe("synced");
    expect(stages.find((s) => s.stage === "postgres")?.status).toBe("failed");
    // The brief's failure shape: Workday must stay "—", not be attempted and marked failed.
    expect(stages.find((s) => s.stage === "workday")?.status).toBe("pending");
    expect(await db.mockWorkdayCount()).toBe(0);
  });

  it("retries a failed PostgreSQL write and completes the rest of the pipeline", async () => {
    faults.postgresDown = true;
    await pipeline.createEmployee(record);
    await settle();
    expect((await db.stagesFor(record.employeeId)).find((s) => s.stage === "postgres")?.status).toBe("failed");

    faults.postgresDown = false;
    const out = await pipeline.retry(record.employeeId);
    expect(out.ok).toBe(true);

    const stages = await db.stagesFor(record.employeeId);
    expect(stages.map((s) => s.status)).toEqual(["synced", "synced", "synced", "synced"]);
    expect(await db.employeeCount()).toBe(1);
    expect(await db.mockWorkdayCount()).toBe(1);
  });

  it("stops at Workday when the target fails, keeping the PostgreSQL row", async () => {
    faults.workdayFail = true;
    await pipeline.createEmployee(record);
    await settle();

    const stages = await db.stagesFor(record.employeeId);
    expect(stages.find((s) => s.stage === "postgres")?.status).toBe("synced");
    expect(stages.find((s) => s.stage === "workday")?.status).toBe("failed");
    expect(await db.getEmployee(record.employeeId)).toBeDefined();
    expect((await db.getEmployee(record.employeeId))?.syncStatus).toBe("failed");

    faults.workdayFail = false;
    await pipeline.retry(record.employeeId);
    expect((await db.stagesFor(record.employeeId)).find((s) => s.stage === "workday")?.status).toBe("synced");
    expect((await db.getEmployee(record.employeeId))?.syncStatus).toBe("synced");
    // The retry must not have written the employee a second time.
    expect(await db.employeeCount()).toBe(1);
  });

  it("does not advance anything while Striim is stalled", async () => {
    faults.striimStall = true;
    await pipeline.createEmployee(record);
    await settle();
    await settle();

    const stages = await db.stagesFor(record.employeeId);
    expect(stages.find((s) => s.stage === "striim")?.status).toBe("pending");
    expect(await db.employeeCount()).toBe(0);

    faults.striimStall = false;
    await settle();
    expect(await db.employeeCount()).toBe(1);
  });

  it("records every pipeline step in the activity log", async () => {
    await pipeline.createEmployee(record);
    await settle();
    const messages = (await db.recentEvents(50)).map((e) => e.message);
    expect(messages.some((m) => /created.*in BambooHR/i.test(m))).toBe(true);
    expect(messages.some((m) => /detected employee\.created/i.test(m))).toBe(true);
    expect(messages.some((m) => /transforming employee record/i.test(m))).toBe(true);
    expect(messages.some((m) => /INSERT successful/i.test(m))).toBe(true);
    expect(messages.some((m) => /Workday synchronization started/i.test(m))).toBe(true);
    expect(messages.some((m) => /synchronization completed/i.test(m))).toBe(true);
  });

  it("exposes a snapshot the dashboard can render without inventing state", async () => {
    await pipeline.createEmployee(record);
    await settle();
    const snap = await pipeline.snapshot();
    expect(snap.systems.postgres.count).toBe(1);
    expect(snap.systems.workday.count).toBe(1);
    expect(snap.employees[0]?.stages.map((s) => s.status)).toEqual(["synced", "synced", "synced", "synced"]);
    expect(snap.config.systems.bamboohr.mode).toBe("mock");
  });
});
