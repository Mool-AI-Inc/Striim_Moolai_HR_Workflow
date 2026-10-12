/**
 * Seed the employees table from the committed fixture.
 * @lifespan THROWAWAY — demo setup. The fixture stays the source of truth for offline
 *   tests; this table is what the migration demo reads and what Striim bulk-copies.
 *
 *   LEDGER_DATABASE_URL=... npx tsx scripts/load-employees.ts
 *   LEDGER_DATABASE_URL=... npx tsx scripts/load-employees.ts --both   (source and target schema)
 */
import { loadDemoEmployees } from "../src/platform/../synthdata/scenarios.js";
import { migrate } from "../src/platform/db/sendLedger.js";
import { upsertEmployee, countEmployees } from "../src/platform/db/employees.js";
import { closePool } from "../src/platform/db/pool.js";
import { loadEnv } from "../src/platform/config/env.js";

async function main(): Promise<void> {
  const employees = loadDemoEmployees();
  // schema.sql is idempotent, so this both creates the table on a fresh database and
  // re-applies the REPLICA IDENTITY FULL that CDC needs for updates to replicate at all.
  await migrate();
  for (const e of employees) await upsertEmployee(e);
  const n = await countEmployees();
  const url = new URL(loadEnv().ledgerDatabaseUrl);
  console.log(`seeded ${employees.length} employees -> ${url.host}${url.pathname} (table now holds ${n})`);
  await closePool();
}

main().catch((e: Error) => { console.error(e.message); process.exit(1); });
