/**
 * The tables the migration moves, and the only table names this module may ever use.
 * @lifespan PRODUCTION — the allow-list that keeps table names out of string interpolation.
 * @responsibility One constant. Nothing here is derived from a request body.
 */

/** Ordered so a reader sees the bulk table first, the way the panel lists them. */
export const MIGRATED_TABLES = [
  "employees",
  "send_ledger",
  "sms_opt_out",
  "pending_approvals",
] as const;

export type MigratedTable = (typeof MIGRATED_TABLES)[number];

/**
 * Every serial/identity column that CDC will NOT advance on the target.
 *
 * CDC copies the VALUE of `id`, never the position of the sequence behind it, so after a
 * load the target's sequence is still at 1 and the first insert after cutover raises a
 * duplicate key. `send_ledger.id` is the only bigserial in the schema today; the shape is
 * a list so adding one later is a line, not a rewrite.
 */
export const SERIAL_COLUMNS: { table: MigratedTable; column: string }[] = [
  { table: "send_ledger", column: "id" },
];

/** True when `name` is a table this module is allowed to touch. */
export function isMigratedTable(name: string): name is MigratedTable {
  return (MIGRATED_TABLES as readonly string[]).includes(name);
}
