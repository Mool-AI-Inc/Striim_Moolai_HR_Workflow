/**
 * Stop an idle Postgres connection from killing the process.
 * @lifespan PRODUCTION — every Pool in this codebase must pass through here.
 *
 * THE CRASH THIS PREVENTS
 *
 * Neon closes idle connections. When it does, `pg` emits an 'error' event on the idle client
 * in the pool. Node treats an unhandled 'error' event as fatal, so the whole process dies:
 *
 *     Error: read ECONNRESET
 *       at TLSWrap.onStreamRead
 *       at Client.idleListener (node_modules/pg-pool/index.js:62)
 *
 * It killed the demo API mid-session. The failure is invisible until it happens, because an
 * idle connection is by definition one nothing is currently using — so it takes the process
 * down at the quietest moment, which in a demo is while someone is talking.
 *
 * Attaching a handler makes it what it actually is: a connection that went away and will be
 * replaced on the next query. The pool already reconnects on its own; it only needed to be
 * told that this is survivable.
 */
import type { Pool } from "pg";

/** Attach the handler, log once per occurrence, and return the pool for chaining. */
export function guardPool(pool: Pool, label: string): Pool {
  pool.on("error", (err: Error) => {
    // Deliberately not rethrown and not counted as fatal. The pool discards the dead client
    // and the next query opens a fresh one; there is nothing for a caller to do about it.
    console.warn(`[db:${label}] idle connection dropped (${err.message}) — pool will reconnect`);
  });
  return pool;
}

/**
 * Pool settings that reduce how often the above happens.
 *
 * keepAlive stops a connection going quiet enough for Neon to reap it, and an idle timeout
 * shorter than Neon's means we close connections ourselves — deliberately, on our terms —
 * rather than discovering later that the far end already did.
 */
export const NEON_POOL_DEFAULTS = {
  max: 4,
  keepAlive: true,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
} as const;
