/**
 * The dangerous test: prove a resumed write-back does not create a duplicate person.
 * @lifespan THROWAWAY — run by hand against a BambooHR test account.
 *
 *   npm run test:writeback
 *
 * This is the only failure in the whole HRIS pipeline you cannot reason your way out of. A
 * migrated employee takes several API calls with no transaction across them, so a failure
 * partway is normal. What must never happen is a retry creating a SECOND person with a second
 * payroll record.
 *
 * The run:
 *   1  preflight the seat count
 *   2  push an employee, deliberately failing at jobInfo    -> employee created, jobInfo failed
 *   3  count people with that email in BambooHR             -> must be exactly 1
 *   4  push the SAME employee again, no injected failure     -> must SKIP the create, do jobInfo
 *   5  count again                                          -> must STILL be exactly 1
 *   6  clean up
 *
 * Step 5 is the assertion. Everything else is setup.
 */
import { Pool } from "pg";
import { loadEnv } from "../src/platform/config/env.js";
import { guardPool, NEON_POOL_DEFAULTS } from "../src/platform/db/poolGuard.js";
import { BambooHRClient } from "../src/platform/hris/bamboohrClient.js";
import { HrisLoader } from "../src/platform/hris/loader.js";

const SOURCE_ID = "MOOLAI-WRITEBACK-TEST-1";
const EMAIL = "moolai.writeback.test@instantteams.test";

function ok(label: string, pass: boolean, detail = ""): boolean {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  return pass;
}

async function main(): Promise<void> {
  const domain = process.env.BAMBOOHR_DOMAIN?.trim();
  const apiKey = process.env.BAMBOOHR_API_KEY?.trim();
  if (!domain || !apiKey) throw new Error("BAMBOOHR_DOMAIN and BAMBOOHR_API_KEY must be set");

  const client = new BambooHRClient({ domain, apiKey });
  const pool = guardPool(new Pool({ ...NEON_POOL_DEFAULTS, connectionString: loadEnv().ledgerDatabaseUrl }), "writeback");
  const loader = new HrisLoader(pool, client);
  let allPass = true;

  // start clean so the test is repeatable
  await pool.query(`DELETE FROM hris_id_map      WHERE source_employee_id = $1`, [SOURCE_ID]);
  await pool.query(`DELETE FROM hris_load_ledger WHERE source_employee_id = $1`, [SOURCE_ID]);

  console.log("\n1. seat-limit preflight");
  const headcount = await loader.remoteHeadcount();
  console.log(`     BambooHR currently holds ${headcount} employees`);

  const plan = {
    sourceEmployeeId: SOURCE_ID,
    employee: { firstName: "Moolai", lastName: "WritebackTest", workEmail: EMAIL },
    tables: {
      // Both are EXISTING list values in the account. An invented jobTitle gets a bare 400
      // with no message — see the note on addTableRow.
      jobInfo: { date: "2026-01-15", jobTitle: "HR Administrator", department: "Human Resources" },
    },
  };

  console.log("\n2. push, failing deliberately at jobInfo");
  const first = await loader.push(plan, { failAtTarget: "jobInfo" });
  console.log(`     created=${first.created} remoteId=${first.remoteId} `
            + `written=[${first.targetsWritten}] error="${first.error ?? ""}"`);
  // Either a fresh create OR a recovery-by-email is correct here. A previous run of this
  // script leaves the test employee in BambooHR, so on a second run the loader SHOULD find
  // them by email and reuse the id rather than creating a twin. Both outcomes are a pass;
  // what would fail is having no id at all.
  allPass = ok("employee exists in BambooHR with a mapped id", !!first.remoteId,
               first.created ? "freshly created" : "recovered by email from an earlier run") && allPass;
  allPass = ok("jobInfo failed as injected", (first.error ?? "").includes("jobInfo")) && allPass;

  console.log("\n3. how many people in BambooHR have that email?");
  const afterFirst = await client.countByEmail(EMAIL);
  allPass = ok("exactly 1 person exists", afterFirst === 1, `found ${afterFirst}`) && allPass;

  console.log("\n4. push the SAME employee again, no injected failure");
  const second = await loader.push(plan);
  console.log(`     created=${second.created} remoteId=${second.remoteId} `
            + `written=[${second.targetsWritten}] skipped=[${second.targetsSkipped}]`);
  allPass = ok("did NOT create a second time", second.created === false) && allPass;
  allPass = ok("reused the same BambooHR id", second.remoteId === first.remoteId,
               `${first.remoteId} -> ${second.remoteId}`) && allPass;
  allPass = ok("skipped the employee record", second.targetsSkipped.includes("employee")) && allPass;
  allPass = ok("completed jobInfo on the retry", second.targetsWritten.includes("jobInfo")) && allPass;

  console.log("\n5. THE ASSERTION — still exactly one person?");
  const afterSecond = await client.countByEmail(EMAIL);
  allPass = ok("no duplicate human was created", afterSecond === 1, `found ${afterSecond}`) && allPass;

  console.log("\n6. ledger state");
  const led = await pool.query<{ target: string; state: string; attempts: number }>(
    `SELECT target, state, attempts FROM hris_load_ledger
      WHERE source_employee_id = $1 ORDER BY target`, [SOURCE_ID]);
  for (const r of led.rows) console.log(`     ${r.target.padEnd(10)} ${r.state.padEnd(7)} attempts=${r.attempts}`);

  console.log(`\n${allPass ? "ALL CHECKS PASSED" : "SOMETHING FAILED — read above"}`);
  console.log(`(test employee ${first.remoteId} left in BambooHR; delete it there if you want it gone)\n`);
  await pool.end();
  process.exit(allPass ? 0 : 1);
}

main().catch((e: Error) => { console.error("\nERROR:", e.message); process.exit(1); });
