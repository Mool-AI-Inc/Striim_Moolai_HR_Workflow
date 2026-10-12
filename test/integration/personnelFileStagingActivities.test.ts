/**
 * createEmployeeStaging ledger-idempotency tests against a real buildSimulator() + real Postgres.
 * @lifespan THROWAWAY — integration-tier test only; needs compose Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildSimulator } from "../../simulator/saasSimulator.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";
import { migrate } from "../../src/platform/db/sendLedger.js";
import { getPool, closePool } from "../../src/platform/db/pool.js";
import type { EmployeeRecord } from "../../src/platform/domain/types.js";

// Same pattern as the other test/integration/*Activities.test.ts files: personnelFile/activities.ts builds
// its PaylocityConnector from loadEnv() at module-top-level, so point PLATFORM_MODE/SIMULATOR_URL at a real
// buildSimulator() on an ephemeral port BEFORE first import.
describe("createEmployeeStaging — ledger-idempotent (integration)", () => {
  let sim: FastifyInstance;
  let simUrl: string;
  let createEmployeeStaging: (companyId: string, employee: EmployeeRecord) => Promise<{ employeeId: string }>;

  beforeAll(async () => {
    await migrate();
    await getPool().query(`TRUNCATE send_ledger, sms_opt_out`);
    sim = buildSimulator([]);
    simUrl = await sim.listen({ port: 0, host: "127.0.0.1" });
    process.env.SIMULATOR_URL = simUrl;
    process.env.PLATFORM_MODE = "demo";
    ({ createEmployeeStaging } = await import("../../src/usecases/personnelFile/activities.js"));
  });

  afterAll(async () => {
    await sim.close();
    await closePool();
  });

  it("stages once; a second call for the same employee is deduped via the ledger, not re-driven through Paylocity Weblink", async () => {
    const employee = makeEmployee({ employeeId: "E-PF-DEDUPE" });

    const first = await createEmployeeStaging("C1", employee);
    expect(first.employeeId).toBeTruthy();
    expect(first.employeeId).not.toBe("skipped");

    const second = await createEmployeeStaging("C1", employee);
    expect(second).toEqual({ employeeId: "skipped" });

    // Weblink "Create New Employee" pushes a new STG_N row onto the simulator's own employee list — a real
    // duplicate call would push a second one.
    const before = (await (await fetch(`${simUrl}/api/v2/companies/C1/employees?pagesize=100&pagenumber=0`)).json()) as { employeeId: string }[];
    expect(before.filter((e) => e.employeeId.startsWith("STG_"))).toHaveLength(1);
  });
});
