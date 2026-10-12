/**
 * Make the local picture match the CURRENT BambooHR tenant — including removals.
 * @lifespan PRODUCTION — the third part of leg 1, after Striim lands and enrich fills.
 *
 *   npm run reconcile:bamboohr
 *
 * WHY THIS IS NEEDED, AND WHY STRIIM CANNOT DO IT
 *
 * Striim's DatabaseWriter UPSERTS. It has no way to know that a row it wrote last week is gone
 * from the source, because the BambooHR Reader fetches the directory and writes what it finds —
 * absence is not an event. So public.bamboohr_employees only ever ACCUMULATES. Verified the hard
 * way: after an expired trial was replaced, ids 115 and 117 ("Alice Rio", "Demo NewHire") were
 * still sitting in the landing table belonging to a tenant that no longer existed, and because the
 * demo picker sorts newest-first they were the first two names on screen.
 *
 * Deleting someone in BambooHR therefore has no effect on anything downstream until something
 * compares the two sides. That something is this script.
 *
 * WHAT IT DOES
 *   1. Reads the live directory and the live custom report (the report includes inactive and
 *      terminated people the directory hides — 109 against 90 on this tenant).
 *   2. Landing rows whose id is in NEITHER -> deleted. That person is not in this tenant at all.
 *   3. employees rows whose id is in neither -> status 'T'. Marked, not deleted, because
 *      pending_approvals and send_ledger reference them and a delete would orphan workflow data.
 *
 * It never invents a removal from a single empty response: if the API returns zero employees it
 * aborts, because "the tenant is empty" and "the tenant is unreachable" look identical from here
 * and one of them would wipe the demo.
 */
import { Pool } from "pg";
import { loadEnv } from "../src/platform/config/env.js";
import { guardPool, NEON_POOL_DEFAULTS } from "../src/platform/db/poolGuard.js";

interface Ids { directory: Set<string>; report: Set<string> }

async function bamboo<T>(domain: string, apiKey: string, path: string, body?: unknown): Promise<T> {
  const auth = "Basic " + Buffer.from(`${apiKey}:x`).toString("base64");
  const r = await fetch(`https://api.bamboohr.com/api/gateway.php/${domain}/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: auth, Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`BambooHR ${path} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

export async function liveIds(domain: string, apiKey: string): Promise<Ids> {
  const dir = await bamboo<{ employees?: { id: string }[] }>(domain, apiKey, "/employees/directory");
  const rep = await bamboo<{ employees?: { id: string }[] }>(
    domain, apiKey, "/reports/custom?format=JSON",
    { title: "moolai-reconcile", fields: ["id", "status"] });

  const directory = new Set((dir.employees ?? []).map((e) => String(e.id)));
  const report = new Set((rep.employees ?? []).map((e) => String(e.id)));

  // The guard that matters. An auth failure, an expired trial or a transient 200-with-empty-body
  // would otherwise read as "every employee was deleted" and this script would faithfully remove
  // all of them. A tenant with no people is not a state worth supporting.
  if (directory.size === 0 && report.size === 0) {
    throw new Error("BambooHR returned no employees at all — refusing to treat that as a mass removal");
  }
  return { directory, report };
}

async function main(): Promise<void> {
  const domain = process.env.BAMBOOHR_DOMAIN?.trim();
  const apiKey = process.env.BAMBOOHR_API_KEY?.trim();
  if (!domain || !apiKey) throw new Error("BAMBOOHR_DOMAIN and BAMBOOHR_API_KEY must be set");

  const { directory, report } = await liveIds(domain, apiKey);
  const known = new Set([...directory, ...report]);
  console.log(`BambooHR now: ${directory.size} in the directory, ${report.size} in the report `
            + `(${known.size} distinct people)`);

  const pool = guardPool(
    new Pool({ ...NEON_POOL_DEFAULTS, connectionString: loadEnv().ledgerDatabaseUrl }), "reconcile");
  try {
    const ids = [...known];

    // 1. Landing rows for people who are not in this tenant.
    const staleLanding = await pool.query<{ id: string; firstname: string; lastname: string }>(
      `SELECT id, firstname, lastname FROM public.bamboohr_employees WHERE NOT (id = ANY($1))`, [ids]);
    for (const r of staleLanding.rows) {
      console.log(`  landing: removing ${r.id} ${r.firstname} ${r.lastname} — not in BambooHR`);
    }
    if (staleLanding.rowCount) {
      await pool.query(`DELETE FROM public.bamboohr_employees WHERE NOT (id = ANY($1))`, [ids]);
    }

    // 2. Employees who have left the tenant entirely. Marked, never deleted.
    const gone = await pool.query<{ employee_id: string; first_name: string; last_name: string }>(
      `UPDATE public.employees SET status = 'T', updated_at = now()
        WHERE employee_id ~ '^[0-9]+$' AND NOT (employee_id = ANY($1)) AND status <> 'T'
        RETURNING employee_id, first_name, last_name`, [ids]);
    for (const r of gone.rows) {
      console.log(`  employees: ${r.employee_id} ${r.first_name} ${r.last_name} -> status T (left the tenant)`);
    }

    // 3. Anyone who came BACK should not stay terminated. The enrich step sets status from the
    //    report, so this only has to undo a previous reconcile for someone now in the directory.
    const back = await pool.query<{ employee_id: string }>(
      `UPDATE public.employees SET status = 'A', updated_at = now()
        WHERE employee_id = ANY($1) AND status = 'T'
        RETURNING employee_id`, [[...directory]]);
    for (const r of back.rows) console.log(`  employees: ${r.employee_id} is back in the directory -> status A`);

    const after = await pool.query<{ landing: string; active: string }>(
      `SELECT (SELECT count(*) FROM public.bamboohr_employees)::text AS landing,
              (SELECT count(*) FROM public.employees
                WHERE employee_id ~ '^[0-9]+$' AND status = 'A')::text AS active`);
    const a = after.rows[0];
    console.log(`  reconciled: landing ${a?.landing} rows · ${a?.active} active BambooHR employees`
              + `  (removed ${staleLanding.rowCount ?? 0} landing, marked ${gone.rowCount ?? 0} terminated,`
              + ` restored ${back.rowCount ?? 0})`);
  } finally {
    await pool.end();
  }
}

// Only when run directly, so the sync step can import liveIds without triggering a run.
import { pathToFileURL } from "node:url";
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((e: Error) => { console.error(e.message); process.exit(1); });
}
