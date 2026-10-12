/**
 * One full leg-1 pass: Striim's landing table -> employees, then the enrich step on top.
 * @lifespan PRODUCTION — the whole of leg 1 after Striim has landed a row.
 *
 *   npm run sync:bamboohr
 *
 * WHY THE ORDER MATTERS, AND WHY BOTH HALVES EXIST
 *
 * Striim's BambooHR Reader lands the DIRECTORY into bamboohr_employees. Before this script
 * existed, nothing read that table: striim/map_bamboohr_to_employees.sql was on disk but
 * referenced by no code, so the Striim application landed 90 rows nobody consumed while
 * enrich-bamboohr.ts populated `employees` on its own with a direct REST call. The pipeline
 * diagram said Striim; the data path said otherwise.
 *
 * So: map first (identity, contact, department, gender, location, job title — everything the
 * directory carries, arriving through Striim), then enrich (hireDate, dateOfBirth, status,
 * employment type, payRate — the fields the reader provably cannot fetch, from BambooHR's
 * custom-report endpoint), then RECONCILE — because neither of the first two can represent a
 * REMOVAL. Striim upserts and never deletes, and the enrich step only touches people the report
 * returns, so someone deleted in BambooHR would otherwise live on in the landing table and in the
 * app's picker forever. Reconcile compares both sides and is the only step that can subtract.
 *
 * The order is not arbitrary. The mapping's ON CONFLICT deliberately does not touch status,
 * employee_type or the date columns, so running it second would not undo the enrich — but it
 * WOULD leave a window where a freshly-landed person sits at the mapping's assumed
 * status='A'/'RFT' until the next enrich. Mapping first closes that window inside one run.
 *
 * Exit code is non-zero if either half fails, so the watcher can tell a real failure from a
 * quiet run instead of printing a cheerful line either way.
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { loadEnv } from "../src/platform/config/env.js";
import { guardPool, NEON_POOL_DEFAULTS } from "../src/platform/db/poolGuard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAP_SQL = join(HERE, "..", "striim", "map_bamboohr_to_employees.sql");

async function map(): Promise<void> {
  const sql = readFileSync(MAP_SQL, "utf8");
  const pool = guardPool(
    new Pool({ ...NEON_POOL_DEFAULTS, connectionString: loadEnv().ledgerDatabaseUrl }),
    "map-bamboohr",
  );
  try {
    const landed = await pool.query<{ n: string }>("SELECT count(*) AS n FROM bamboohr_employees");
    // A landing table with nothing in it means Striim is not delivering. Say so rather than
    // reporting a successful mapping of zero rows, which reads like everything is fine.
    if (landed.rows[0]?.n === "0") {
      throw new Error(
        "bamboohr_employees is empty — Striim has landed nothing. Check " +
        "`python striim/deploy.py status`; the app halts on a dead BambooHR tenant.",
      );
    }
    const res = await pool.query(sql);
    console.log(`map: ${landed.rows[0]?.n} landed rows -> ${res.rowCount} employees upserted`);
  } finally {
    await pool.end();
  }
}

function enrich(): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["tsx", "--env-file-if-exists=.env", "scripts/enrich-bamboohr.ts"],
                    { stdio: "inherit", shell: true });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`enrich exited ${code}`))));
  });
}

function reconcile(): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["tsx", "--env-file-if-exists=.env", "scripts/reconcile-bamboohr.ts"],
                    { stdio: "inherit", shell: true });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`reconcile exited ${code}`))));
  });
}

async function main(): Promise<void> {
  await map();
  await enrich();
  // Reconcile is NOT run here. It is the only step that SUBTRACTS — it deletes landing rows and
  // marks people terminated — and the onboarding journey only ever adds. A destructive step in a
  // loop that runs every 30 seconds during a live demo is risk with no matching benefit. Run it
  // by hand (`npm run reconcile:bamboohr`) after deleting someone in BambooHR, which is the only
  // time it has anything to do.
  if (process.env.SYNC_RECONCILE === "1") await reconcile();
}
main().catch((e: Error) => { console.error(`sync failed: ${e.message}`); process.exit(1); });
