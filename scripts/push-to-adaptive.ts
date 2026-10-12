/**
 * Beat 2: push migrated employees from Postgres into Workday Adaptive Planning.
 * @lifespan THROWAWAY — demo runner.
 *
 *   npm run push:adaptive                          dry run — prints the XML, sends nothing
 *   npm run push:adaptive -- --live                actually writes
 *   npm run push:adaptive -- --currency GBP        push a different currency's cohort
 *   npm run push:adaptive -- --hourly-annualised   include hourly staff, converted x2080
 *
 * DRY RUN IS THE DEFAULT AND THAT IS DELIBERATE. Adaptive is a planning model, not a record
 * store: a write changes numbers that people report on, and the Slack agent in this same
 * estate answers pay-equity questions from this very instance. So the operator reads the
 * payload first, then decides.
 *
 * Striim cannot do this leg — no Workday or Adaptive writer exists on the cluster in either
 * direction. See src/platform/hris/adaptiveClient.ts.
 */
import { Pool } from "pg";
import { loadEnv } from "../src/platform/config/env.js";
import { guardPool, NEON_POOL_DEFAULTS } from "../src/platform/db/poolGuard.js";
import { AdaptiveClient, type AdaptiveRow } from "../src/platform/hris/adaptiveClient.js";

const LIVE = process.argv.includes("--live");
const LIMIT = Number(process.env.ADAPTIVE_PUSH_LIMIT ?? 3);

/**
 * ONE CURRENCY PER PUSH, AND SALARIED ONLY UNLESS TOLD OTHERWISE.
 *
 * "PY Pay" is a single unlabelled numeric column. It carries no currency and no period, so
 * whatever lands in it is implicitly comparable to everything already there. This account holds
 * five currencies (USD 74, GBP 13, CAD 10, AUD 9, HKD 1) and 25 of 109 people are paid HOURLY
 * at 12.50-44.71 against salaries up to 1,000,000. Writing that set into one column does not
 * produce a slightly-wrong model, it produces a meaningless one — and the Slack agent on this
 * same Adaptive instance answers pay-equity questions from it.
 *
 * So the default is the only subset that needs no assumption: one currency, period = Year.
 * Everything else is excluded and counted out loud, so the operator sees what was left behind
 * instead of discovering it in a report later.
 */
const CURRENCY = (() => {
  const i = process.argv.indexOf("--currency");
  return (i >= 0 ? process.argv[i + 1] : undefined) ?? process.env.ADAPTIVE_PUSH_CURRENCY ?? "USD";
})();
/** x2080 = 40h x 52w. An ASSUMPTION, so it is opt-in and it is printed next to the figure. */
const HOURLY_ANNUALISED = process.argv.includes("--hourly-annualised");
const HOURS_PER_YEAR = 2080;

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`missing ${name} — copy it from the WorkdayAdaptiveAgent .env`);
  return v;
}

async function main(): Promise<void> {
  // Both default to the sheet the MoolAI Adaptive agent ALREADY writes to successfully, so no
  // new sheet and no Adaptive admin work is needed. "PY Pay" is the display name that agent
  // resolves PayRate to on this sheet.
  const SHEET = process.env.ADAPTIVE_SHEET_NAME?.trim() ?? "EUPTD - Employee Demographics";
  const METRIC = process.env.ADAPTIVE_METRIC_COLUMN?.trim() ?? "PY Pay";

  const client = new AdaptiveClient({
    apiUrl: required("ADAPTIVE_API_URL"),
    tokenUrl: required("ADAPTIVE_TOKEN_URL"),
    tokenExchangeUrl: required("ADAPTIVE_TOKEN_EXCHANGE_URL"),
    clientId: required("ADAPTIVE_CLIENT_ID"),
    clientSecret: required("ADAPTIVE_CLIENT_SECRET"),
    refreshToken: required("ADAPTIVE_REFRESH_TOKEN"),
    version: process.env.ADAPTIVE_VERSION?.trim() ?? "default",
    instanceCode: process.env.ADAPTIVE_INSTANCE_CODE?.trim(),
    level: process.env.ADAPTIVE_LEVEL?.trim() ?? "",
    // The sheet MUST already exist in Adaptive with an import template whose columns match
    // the header this builds. A sheet that does not exist fails at the API, not here.
    // Defaults to the sheet the MoolAI Adaptive agent ALREADY writes to successfully, so no
    // new sheet and no Adaptive admin work is required. Override to target a different one.
    sheetName: SHEET,
    importKey: process.env.ADAPTIVE_IMPORT_KEY?.trim() ?? "EmpID_EUPTD",
  });

  const pool = guardPool(new Pool({ ...NEON_POOL_DEFAULTS, connectionString: loadEnv().ledgerDatabaseUrl }), "adaptive");
  // Say what is being left out BEFORE selecting, so exclusions are visible rather than
  // implied by a smaller row count.
  const audit = await pool.query<{ reason: string; n: string }>(
    `SELECT reason, count(*)::text AS n FROM (
       SELECT CASE
         WHEN NOT EXISTS (SELECT 1 FROM bamboohr_employees b WHERE b.id = e.employee_id)
           THEN 'not in the current BambooHR tenant'
         WHEN e.status <> 'A'      THEN 'not active'
         WHEN e.pay_rate IS NULL   THEN 'no pay figure in BambooHR'
         WHEN e.pay_currency IS DISTINCT FROM $1
           THEN 'other currency: ' || COALESCE(e.pay_currency, 'none')
         WHEN e.pay_period = 'Hour' THEN 'paid hourly'
         WHEN e.pay_period IS DISTINCT FROM 'Year' THEN 'unknown pay period'
         ELSE 'INCLUDED'
       END AS reason
       FROM employees e WHERE e.employee_id ~ '^[0-9]+$'
     ) t GROUP BY reason ORDER BY 2 DESC`, [CURRENCY]);

  // Only employees that came from BambooHR, and only active ones — pushing a terminated
  // person into a headcount plan would overstate the plan.
  //
  // The join to bamboohr_employees is the tenant gate, and it is why Striim's landing table is
  // not decorative: a person is pushable only if the CURRENT tenant's directory still lists
  // them. Without it, leftovers from an expired trial are eligible, and because the sort is by
  // descending id they sort FIRST. Id 115 "Alice Rio" (1000 USD, "Remote Worker") was top of
  // the queue before this clause existed, and she exists in no BambooHR account at all.
  const r = await pool.query<{
    employee_id: string; first_name: string; last_name: string;
    cost_center: string; pay_rate: string | null; pay_currency: string | null;
    pay_period: string | null; pay_type: string | null;
    gender: string | null; location: string | null; job_title: string | null;
  }>(`SELECT e.employee_id, e.first_name, e.last_name, e.cost_center, e.pay_rate,
             e.pay_currency, e.pay_period, e.pay_type, e.gender, e.location, e.job_title
        FROM employees e
        JOIN bamboohr_employees b ON b.id = e.employee_id
       WHERE e.employee_id ~ '^[0-9]+$' AND e.status = 'A'
         -- No pay figure, no row. The target column on this sheet is a PAY column, and
         -- writing a placeholder into a pay-equity model is worse than writing nothing.
         AND e.pay_rate IS NOT NULL
         AND e.pay_currency = $2
         AND (e.pay_period = 'Year' OR ($3 AND e.pay_period = 'Hour'))
       ORDER BY (e.employee_id)::int DESC
       LIMIT $1`, [LIMIT, CURRENCY, HOURLY_ANNUALISED]);
  await pool.end();

  console.log(`selection: currency ${CURRENCY}, period Year`
            + `${HOURLY_ANNUALISED ? ` + hourly annualised x${HOURS_PER_YEAR}` : ""}`);
  for (const a of audit.rows) console.log(`  ${a.n.padStart(4)}  ${a.reason}`);
  console.log("");

  if (r.rows.length === 0) { console.log("no active BambooHR employees to push"); return; }

  const month = new Date().toISOString().slice(0, 7).split("-").reverse().join("/"); // MM/YYYY
  const rows: AdaptiveRow[] = r.rows.map((e) => ({
    employeeId: e.employee_id,
    workerName: `${e.first_name} ${e.last_name}`.trim(),
    month,
    // "PY Pay" is the display name the agent resolves PayRate to on this sheet.
    metricColumn: METRIC,
    // The real figure from BambooHR, parsed out of "65000.00 USD" by the enrichment step.
    // Annualised only when explicitly asked for, and the multiplier is printed beside the row
    // so a converted number is never mistaken for one BambooHR supplied.
    value: e.pay_period === "Hour" ? Number(e.pay_rate) * HOURS_PER_YEAR : Number(e.pay_rate),
    // Dimension names match the sheet's import template. Cost centre maps to Job_Group here
    // because that is the column the demographics sheet carries.
    //
    // Gender and Location DO arrive: they are columns on the BambooHR directory, the mapping
    // step carries them, and 109 of 112 rows have both. An earlier version of this comment
    // claimed the directory does not supply them and that they were deliberately blanked. That
    // was wrong, and it read as a justification for missing data that was in fact available.
    // Every column is a real BambooHR value, so the HRIS and the planning model show the SAME
    // record rather than two partial views of it. Nothing here is inferred: a blank means
    // BambooHR had no value, which in a pay-equity model is the honest answer.
    dimensions: {
      Gender: e.gender ?? "",
      Location: e.location ?? "",
      Job_Group: e.cost_center,           // BambooHR department
      Job_Classification: e.job_title ?? "",
    },
  }));

  console.log(`${LIVE ? "LIVE" : "DRY RUN"} — ${rows.length} employee(s), sheet "${SHEET}", metric "${METRIC}"\n`);
  for (const [i, row] of rows.entries()) {
    const d = row.dimensions ?? {};
    console.log(`  ${row.employeeId.padStart(4)}  ${row.workerName.padEnd(20)} `
              + `${(d.Gender ?? "").padEnd(7)} ${(d.Location ?? "").padEnd(22)} `
              + `${(d.Job_Group ?? "").padEnd(18)} ${(d.Job_Classification ?? "").padEnd(22)} `
              + `${row.value} ${r.rows[i]?.pay_currency ?? ""}`
              + `${r.rows[i]?.pay_period === "Hour"
                    ? `  (${r.rows[i]?.pay_rate}/hr x ${HOURS_PER_YEAR})` : ""}`);
  }

  console.log("\n--- the exact request that would be sent ---\n");
  console.log(client.buildImportXml(rows));

  if (!LIVE) {
    console.log("\nNothing was sent. Re-run with --live to write for real.");
    return;
  }

  console.log("\nsending...");
  const res = await client.importRows(rows);
  console.log(`  ${res.success ? "SUCCESS" : "FAILED"}: ${res.message}`);
  process.exit(res.success ? 0 : 1);
}

main().catch((e: Error) => { console.error("\nERROR:", e.message); process.exit(1); });
