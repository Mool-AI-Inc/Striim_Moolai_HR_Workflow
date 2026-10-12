/**
 * Shared Postgres pool for the ledger + approvals inbox.
 * @lifespan PRODUCTION — one pool per process, lazily created from env.ledgerDatabaseUrl.
 */
import { Pool } from "pg";
import { loadEnv } from "../config/env.js";
import { guardPool, NEON_POOL_DEFAULTS } from "./poolGuard.js";

let pool: Pool | undefined;

export function getPool(): Pool {
  // guardPool is not optional: without it an idle connection dropped by Neon raises an
  // unhandled 'error' event and kills the process. See poolGuard.ts.
  if (!pool) {
    pool = guardPool(
      new Pool({ ...NEON_POOL_DEFAULTS, connectionString: loadEnv().ledgerDatabaseUrl }),
      "ledger",
    );
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) { await pool.end(); pool = undefined; }
}
