/**
 * The replication slot, read directly from the source.
 * @lifespan PRODUCTION — the gate that decides when the bulk load may safely begin.
 * @responsibility Create the slot if absent; report whether it is real and holding.
 *
 * Why this exists rather than asking Striim.
 *
 * Measured on this cluster: the CDC application reports RUNNING roughly 15 seconds BEFORE
 * the slot is actually held.
 *
 *     t+ 0s  app=RUNNING  slot_active=false  pid=null
 *     t+15s  app=RUNNING  slot_active=true   pid=2489
 *
 * The whole reason CDC is started before the bulk load is that writes landing before the
 * slot is held are lost, with no error anywhere. Gating the bulk load on the app saying
 * RUNNING therefore opens the gate about fifteen seconds too early. Striim's /health also
 * lags ~2 minutes, so app state is the wrong signal twice over.
 *
 * pg_replication_slots IS the precondition. It is on the source, it is instant, and it
 * cannot disagree with itself.
 *
 * One wrinkle: the reader connects and disconnects on roughly a 30-second cycle, so
 * `active` reads false on a perfectly healthy pipeline. `hasEverAttached` is therefore
 * sticky — once we have seen it held, it stays held for gating purposes.
 */
import { Pool } from "pg";

export interface SlotState {
  name: string;
  exists: boolean;
  active: boolean;
  plugin: string | null;
  restartLsn: string | null;
  confirmedFlushLsn: string | null;
  currentWalLsn: string | null;
}

export async function slotState(source: Pool, name: string): Promise<SlotState> {
  const r = await source.query<{
    plugin: string | null; active: boolean; restart_lsn: string | null;
    confirmed_flush_lsn: string | null; current: string | null;
  }>(
    `SELECT plugin, active, restart_lsn::text, confirmed_flush_lsn::text,
            pg_current_wal_lsn()::text AS current
       FROM pg_replication_slots WHERE slot_name = $1`, [name],
  );
  const row = r.rows[0];
  if (!row) {
    const wal = await source.query<{ current: string }>(`SELECT pg_current_wal_lsn()::text AS current`);
    return { name, exists: false, active: false, plugin: null, restartLsn: null,
             confirmedFlushLsn: null, currentWalLsn: wal.rows[0]?.current ?? null };
  }
  return {
    name, exists: true, active: row.active, plugin: row.plugin,
    restartLsn: row.restart_lsn, confirmedFlushLsn: row.confirmed_flush_lsn,
    currentWalLsn: row.current,
  };
}

/**
 * Create the slot if it is not already there.
 *
 * Striim does NOT create it. The reader starts, finds nothing, and the application goes
 * straight to HALT with "Specified slot is not created" — which reads like a
 * configuration error rather than a missing prerequisite.
 */
export async function ensureSlot(source: Pool, name: string): Promise<SlotState> {
  const before = await slotState(source, name);
  if (before.exists) return before;
  await source.query(`SELECT pg_create_logical_replication_slot($1, 'wal2json')`, [name]);
  return slotState(source, name);
}

export async function dropSlot(source: Pool, name: string): Promise<void> {
  await source.query(
    `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = $1`,
    [name],
  );
}
