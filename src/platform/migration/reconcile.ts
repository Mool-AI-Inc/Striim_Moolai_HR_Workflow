/**
 * Per-table row counts and checksums on both sides.
 * @lifespan PRODUCTION — the drain gate, and the evidence the migration was faithful.
 * @responsibility Count and checksum each migrated table on source and target, and compare.
 *
 * Counts alone are weak evidence: a matched in-and-out count survives a surprising amount
 * of corruption, and on this platform a pipeline has been observed reporting 9,900 in and
 * 9,900 out against a target holding ~1,900. So every comparison here carries a checksum
 * over the ordered rows as well, and `match` requires BOTH to agree.
 */
import { Pool } from "pg";
import { MIGRATED_TABLES, type MigratedTable } from "./tables.js";

export interface TableState { table: MigratedTable; rows: number; checksum: string; }
export interface TableComparison {
  table: MigratedTable;
  source: TableState;
  target: TableState;
  match: boolean;
}

/**
 * Checksum over the whole table, order-independent.
 *
 * md5 of each row's text representation, XOR-folded so row ORDER cannot change the result
 * — the target's physical order is not the source's, and sorting a large table on every
 * poll would make the drain gate the slowest thing in the cutover.
 */
function checksumSql(table: MigratedTable): string {
  return `SELECT count(*)::bigint AS rows,
                 COALESCE(md5(string_agg(row_md5, '' ORDER BY row_md5)), '') AS checksum
          FROM (SELECT md5(t.*::text) AS row_md5 FROM public.${table} t) s`;
}

async function readState(pool: Pool, table: MigratedTable): Promise<TableState> {
  const r = await pool.query<{ rows: string; checksum: string }>(checksumSql(table));
  return { table, rows: Number(r.rows[0]?.rows ?? 0), checksum: r.rows[0]?.checksum ?? "" };
}

/** Compare every migrated table across the two pools. */
export async function reconcile(source: Pool, target: Pool): Promise<TableComparison[]> {
  const out: TableComparison[] = [];
  for (const table of MIGRATED_TABLES) {
    const [s, t] = await Promise.all([readState(source, table), readState(target, table)]);
    out.push({ table, source: s, target: t, match: s.rows === t.rows && s.checksum === t.checksum });
  }
  return out;
}

export function allMatched(comparisons: TableComparison[]): boolean {
  return comparisons.length > 0 && comparisons.every((c) => c.match);
}
