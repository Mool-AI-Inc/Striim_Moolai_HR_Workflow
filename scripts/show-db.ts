/**
 * Print what is actually in Postgres, for showing on screen during a demo.
 * @lifespan PRODUCTION — read-only. The answer to "is that just your dashboard?"
 *
 *   npm run show:db            both pipelines, summary + latest rows
 *   npm run show:db -- forward  only BambooHR -> Workday
 *   npm run show:db -- reverse  only Workday -> BambooHR
 *   npm run show:db -- striim   only the table the real Striim application writes
 *
 * This exists because psql is not installed on this machine, and "trust the dashboard" is a weak
 * answer when the whole claim is that the dashboard reflects real database state. Every query
 * below is a plain SELECT against the same database the apps use.
 */
import { Pool } from "pg";
import { guardPool, NEON_POOL_DEFAULTS } from "../src/platform/db/poolGuard.js";

const which = (process.argv[2] ?? "all").toLowerCase();

const url = process.env.SYNCDEMO_DATABASE_URL
  ?? process.env.LEDGER_DATABASE_URL
  ?? "";
if (!url) throw new Error("set LEDGER_DATABASE_URL (or SYNCDEMO_DATABASE_URL)");

const pool = guardPool(new Pool({ ...NEON_POOL_DEFAULTS, connectionString: url }), "show-db");

const rule = (title: string) => {
  console.log(`\n${"─".repeat(78)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(78));
};

/** Print rows as an aligned table, or say plainly that there are none. */
async function show(title: string, sql: string, params: unknown[] = []): Promise<void> {
  console.log(`\n  ${title}`);
  try {
    const r = await pool.query(sql, params);
    if (r.rows.length === 0) { console.log("    (no rows)"); return; }
    const cols = Object.keys(r.rows[0] as object);
    const width = cols.map((c) =>
      Math.min(34, Math.max(c.length, ...r.rows.map((row) => String((row as Record<string, unknown>)[c] ?? "").length))));
    const line = (cells: string[]) =>
      "    " + cells.map((v, i) => v.slice(0, width[i] as number).padEnd(width[i] as number)).join("  ");
    console.log(line(cols));
    console.log("    " + width.map((w) => "-".repeat(w)).join("  "));
    for (const row of r.rows) {
      console.log(line(cols.map((c) => String((row as Record<string, unknown>)[c] ?? ""))));
    }
  } catch (e) {
    // A missing table is normal if that pipeline has never run; say which, rather than a stack.
    console.log(`    unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main(): Promise<void> {
  const host = (() => { try { return new URL(url).host; } catch { return "unknown"; } })();
  console.log(`\n  database: ${host}`);

  if (which === "all" || which === "striim") {
    rule("STRIIM'S OWN OUTPUT — public.bamboohr_employees");
    console.log("  Written by the real Striim application sarah_moolai.BambooHRToPostgres.");
    console.log("  Nothing in this repo writes this table; if a row is here, Striim put it here.");
    await show("row count", "SELECT count(*) AS landed_by_striim FROM public.bamboohr_employees");
    await show("5 most recent by id",
      `SELECT id, firstname, lastname, workemail, department, location
         FROM public.bamboohr_employees ORDER BY (id)::int DESC LIMIT 5`);
  }

  if (which === "all" || which === "forward") {
    rule("FORWARD PIPELINE (:3000) — BambooHR -> Striim -> PostgreSQL -> Workday");
    await show("syncdemo.employees — what the website reads",
      `SELECT employee_id, first_name, last_name, email, department, pay_rate, sync_status
         FROM syncdemo.employees ORDER BY created_at DESC LIMIT 10`);
    await show("syncdemo.employee_workday_mapping — BambooHR id -> Adaptive member",
      `SELECT bamboo_employee_id, workday_slot_id, employee_name, status, updated_at
         FROM syncdemo.employee_workday_mapping ORDER BY created_at DESC LIMIT 10`);
    await show("slot pool usage",
      `SELECT status, count(*) AS n FROM syncdemo.employee_workday_mapping GROUP BY status`);
  }

  if (which === "all" || which === "reverse") {
    rule("REVERSE PIPELINE (:3001) — Workday -> PostgreSQL -> BambooHR");
    await show("revdemo.workday_landing — read out of Adaptive",
      `SELECT member_id, worker_name, location, pay_rate
         FROM revdemo.workday_landing ORDER BY member_id LIMIT 8`);
    await show("revdemo.employees — mapped to our contract",
      `SELECT member_id, first_name, last_name, email, job_title, pay_rate, sync_status
         FROM revdemo.employees ORDER BY created_at DESC LIMIT 10`);
    await show("revdemo.bamboohr_mapping — Workday member -> BambooHR employee",
      `SELECT member_id, bamboo_employee_id, email, status, updated_at
         FROM revdemo.bamboohr_mapping ORDER BY created_at DESC LIMIT 10`);
  }

  console.log("");
  await pool.end();
}

main().catch((e: Error) => { console.error(e.message); process.exit(1); });
