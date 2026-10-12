/**
 * Reverse pipeline: Workday/Adaptive -> PostgreSQL -> BambooHR.
 *
 * The end-to-end tests run with BambooHR MOCKED, deliberately. A live create is permanent — that
 * API has no delete — so a test suite that created people would leave a growing pile of real
 * records in a real HRIS and eventually exhaust the account's seats. The mock exercises the same
 * orchestration, the same mapping and the same idempotency gate; only the final HTTP call differs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mapMember, splitName, synthEmail } from "../../src/reversedemo/server/pipeline.js";

const DB = process.env.SYNCDEMO_TEST_DATABASE_URL
        ?? process.env.SYNCDEMO_DATABASE_URL
        ?? process.env.LEDGER_DATABASE_URL;

const DOMAIN = "workday-import.example.com";

describe("name splitting", () => {
  it("splits an ordinary two-part name", () => {
    expect(splitName("Jamie Stone")).toEqual({ firstName: "Jamie", lastName: "Stone" });
  });

  it("treats everything after the first token as the surname", () => {
    // Lossy and acknowledged: Adaptive stores ONE display name, so this is the best available
    // guess. "Maria del Carmen Lopez" becomes Maria / del Carmen Lopez, which is wrong for her and
    // right for most of this dataset. The alternative — guessing a middle name — is worse.
    expect(splitName("Maria del Carmen Lopez"))
      .toEqual({ firstName: "Maria", lastName: "del Carmen Lopez" });
  });

  it("does not produce an empty surname, which BambooHR rejects", () => {
    expect(splitName("Cher").lastName).toBe("-");
    expect(splitName("   ")).toEqual({ firstName: "Unknown", lastName: "Unknown" });
  });
});

describe("email synthesis", () => {
  it("builds a deterministic address from the name and member id", () => {
    expect(synthEmail({ memberId: "EMP_0337", workerName: "Jamie Stone" }, DOMAIN))
      .toBe("jamie.stone.emp.0337@workday-import.example.com");
  });

  it("is stable — the same member always yields the same address", () => {
    const m = { memberId: "EMP_0019", workerName: "Jan Wilmer" };
    expect(synthEmail(m, DOMAIN)).toBe(synthEmail(m, DOMAIN));
  });

  it("keeps two people with the same name apart", () => {
    // This is the whole reason the member id is in the address. BambooHR rejects duplicate
    // emails, so without it the second Jamie Stone would silently collapse onto the first.
    const a = synthEmail({ memberId: "EMP_0337", workerName: "Jamie Stone" }, DOMAIN);
    const b = synthEmail({ memberId: "EMP_0999", workerName: "Jamie Stone" }, DOMAIN);
    expect(a).not.toBe(b);
  });

  it("survives punctuation and accents in a name", () => {
    const e = synthEmail({ memberId: "EMP_1", workerName: "Jean-Luc O'Brien" }, DOMAIN);
    expect(e).toMatch(/^[a-z0-9.@-]+$/);
    expect(e.endsWith(`@${DOMAIN}`)).toBe(true);
  });
});

describe("mapping a Workday member", () => {
  it("carries location, job title, department and pay", () => {
    expect(mapMember({
      memberId: "EMP_0042", workerName: "Florian Peeters", location: "Brussels",
      jobGroup: "Junior", jobClass: "104 - Software Developer I", payRate: 47301,
    }, DOMAIN)).toMatchObject({
      memberId: "EMP_0042", firstName: "Florian", lastName: "Peeters",
      location: "Brussels", department: "Junior", jobTitle: "104 - Software Developer I",
      payRate: 47301,
    });
  });

  it("drops the sheet's placeholder dimension values instead of writing them to an HRIS", () => {
    // The EUPTD export genuinely contains the literal strings "Job_Group" and
    // "Job_Classification" for some rows. Passing those through would put nonsense into a real
    // employee record.
    const out = mapMember({
      memberId: "EMP_0019", workerName: "Jan Wilmer",
      jobGroup: "Job_Group", jobClass: "Job_Classification",
    }, DOMAIN);
    expect(out.department).toBeUndefined();
    expect(out.jobTitle).toBeUndefined();
  });
});

describe.skipIf(!DB)("import, with BambooHR mocked", () => {
  let db: typeof import("../../src/reversedemo/server/db.js");
  let pipeline: import("../../src/reversedemo/server/pipeline.js").ReversePipeline;

  beforeAll(async () => {
    process.env.REVDEMO_DATABASE_URL = DB;
    process.env.REVDEMO_MODE = "mock";          // never a real create from a test
    // REVDEMO_SCHEMA is NOT set here — it cannot be, db.ts reads it at module load and the
    // static imports above have already pulled it in. vitest.config.ts sets it. Asserted
    // below so a config change cannot silently point this suite at the running app's schema.
    process.env.REVDEMO_EMAIL_DOMAIN = DOMAIN;
    db = await import("../../src/reversedemo/server/db.js");
    const { ReversePipeline, loadReverseConfig } = await import("../../src/reversedemo/server/pipeline.js");
    expect(db.schemaName).toBe("revdemo_test");
    await db.migrate(DB!);
    pipeline = new ReversePipeline(loadReverseConfig());
  });

  afterAll(async () => { await db.closePool(); });

  beforeEach(async () => { await db.resetLocal(); });

  it("reads Workday, then moves one member through all four stages", async () => {
    const { members } = await pipeline.refreshFromWorkday();
    expect(members).toBeGreaterThan(0);

    // Nothing has been imported by the read alone — the read is read-only.
    expect(await db.employeeCount()).toBe(0);

    const out = await pipeline.importMember("EMP_0019");
    expect(out.created).toBe(true);
    expect(out.bambooEmployeeId).toBeDefined();

    const stages = await db.stagesFor("EMP_0019");
    expect(stages.map((s) => s.status)).toEqual(["synced", "synced", "synced", "synced"]);

    const [row] = await db.listEmployees(10);
    expect(row).toMatchObject({
      memberId: "EMP_0019", firstName: "Jan", lastName: "Wilmer",
      email: "jan.wilmer.emp.0019@workday-import.example.com",
      mapStatus: "CREATED",
    });
  });

  it("never imports the same Workday member twice", async () => {
    await pipeline.refreshFromWorkday();
    const first = await pipeline.importMember("EMP_0019");
    for (let i = 0; i < 4; i += 1) {
      const again = await pipeline.importMember("EMP_0019");
      expect(again.created).toBe(false);
      expect(again.bambooEmployeeId).toBe(first.bambooEmployeeId);
    }
    expect(await db.createdCount()).toBe(1);
    expect(await db.employeeCount()).toBe(1);
  });

  it("refuses a member that was never read from Workday", async () => {
    await expect(pipeline.importMember("EMP_NOPE"))
      .rejects.toThrow(/not in the Workday landing table/);
  });

  it("keeps the mapping after a reconnect", async () => {
    await pipeline.refreshFromWorkday();
    await pipeline.importMember("EMP_0019");
    await db.closePool();
    db.getPool(DB!);
    expect((await db.getMapping("EMP_0019"))?.status).toBe("CREATED");
  });

  it("imports several members independently", async () => {
    await pipeline.refreshFromWorkday();
    for (const id of ["EMP_0019", "EMP_0337", "EMP_0042"]) {
      const out = await pipeline.importMember(id);
      expect(out.created).toBe(true);
    }
    expect(await db.createdCount()).toBe(3);
    const rows = await db.listEmployees(10);
    // Every synthesised address is distinct, which is what stops BambooHR rejecting the second.
    expect(new Set(rows.map((r) => r.email)).size).toBe(3);
  });
}, 120_000);
