/**
 * Advance the target's sequences after a CDC load.
 * @lifespan PRODUCTION — the step whose absence breaks the FIRST write after cutover.
 * @responsibility setval every serial column's sequence to the max id present on the target.
 *
 * CDC replicates the VALUE of a bigserial column, never the position of the sequence that
 * generated it. So a target that has just received 400 ledger rows still has its sequence
 * sitting at 1, and the first insert after the cutover raises a duplicate key on a primary
 * key the application never sets by hand. It surfaces as the first action a person takes
 * after the migration, which is the worst possible moment to discover it.
 */
import { Pool } from "pg";
import { SERIAL_COLUMNS } from "./tables.js";

export interface SequenceState { table: string; column: string; sequence: string; lastValue: number; }

/**
 * `setval(seq, n)` makes the NEXT value n+1, so passing MAX(id) is correct.
 * COALESCE handles an empty table: setval(...,1) leaves the next value at 2, which wastes
 * id 1 and is otherwise harmless — the alternative (is_called=false) is more moving parts
 * for a row nobody will look for.
 *
 * pg_get_serial_sequence resolves the sequence name from the catalogue rather than
 * assuming the `<table>_<column>_seq` convention, which is only a convention.
 */
export async function advanceSequences(target: Pool): Promise<SequenceState[]> {
  const out: SequenceState[] = [];
  for (const { table, column } of SERIAL_COLUMNS) {
    const seqRow = await target.query<{ seq: string | null }>(
      `SELECT pg_get_serial_sequence($1, $2) AS seq`, [`public.${table}`, column],
    );
    const sequence = seqRow.rows[0]?.seq;
    if (!sequence) continue;            // not a serial column on this target; nothing to advance
    const r = await target.query<{ last: string }>(
      `SELECT setval($1, COALESCE((SELECT MAX(${column}) FROM public.${table}), 1))::bigint AS last`,
      [sequence],
    );
    out.push({ table, column, sequence, lastValue: Number(r.rows[0]?.last ?? 0) });
  }
  return out;
}
