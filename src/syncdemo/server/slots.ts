/**
 * Workday/Adaptive slot allocation.
 * @lifespan PRODUCTION — the only place a destination member is chosen or released.
 * @responsibility Claim the next free member atomically, persist the mapping, report the pool.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE
 *
 * The pipeline may only ever write to a member in the configured pool. Never to an existing real
 * employee. That is not a convention here, it is the shape of the code: the claim statement
 * selects exclusively from the configured list, so there is no path by which an arbitrary member
 * id reaches Adaptive.
 *
 * ALLOCATION IS DONE BY POSTGRES, NOT BY JAVASCRIPT
 *
 * Picking "the first free slot" in application code means read-then-write, and two employees
 * arriving in the same second both read the same free slot. Instead the claim is a single
 * INSERT .. SELECT .. WHERE NOT EXISTS .. LIMIT 1, and `workday_slot_id` is UNIQUE. The database
 * decides, and the loser of a race gets a constraint violation rather than a duplicate.
 */
import { getPool, schemaName } from "./db.js";

export type SlotStatus = "AVAILABLE" | "CLAIMED" | "SYNCING" | "SYNCED" | "FAILED";

export interface SlotRow {
  slot: string;
  status: SlotStatus;
  employeeId?: string;
  employeeName?: string;
  detail?: string;
  updatedAt?: string;
}

export interface Mapping {
  employeeId: string;
  slot: string;
  employeeName?: string;
  status: Exclude<SlotStatus, "AVAILABLE">;
  detail?: string;
}

export class NoSlotsAvailable extends Error {
  constructor(readonly poolSize: number) {
    super(
      `No available Workday/Adaptive demo slots — all ${poolSize} are occupied. `
      + "Please add additional slots before processing another employee.");
    this.name = "NoSlotsAvailable";
  }
}

const S = schemaName;

/**
 * The pool, when ADAPTIVE_DEMO_SLOTS is not set.
 *
 * Lives here rather than in config.ts so there is exactly one place that decides which
 * members may be written. config.ts re-exports this via configuredSlots() for display;
 * the allocator reads it directly. Two parsers of the same variable is how a dashboard ends
 * up showing twenty slots while the allocator believes in five.
 */
const DEFAULT_SLOTS = "EMP_9001,EMP_9002,EMP_9003,EMP_9004,EMP_9005,EMP_9006,EMP_9007,EMP_9008,EMP_9009,EMP_9010,EMP_9011,EMP_9012,EMP_9013,EMP_9014,EMP_9015,EMP_9016,EMP_9017,EMP_9018,EMP_9019,EMP_9020";

/**
 * The configured pool, in order. Order matters: it is the allocation order, so EMP_9001 is handed
 * out before EMP_9002 and the ranges in the operator's head stay meaningful.
 *
 * Read per call rather than cached at import time so a change to .env takes effect on restart
 * without a module-load ordering puzzle — the same trap that put the test suite in the wrong
 * schema earlier in this project.
 */
export function configuredSlots(): string[] {
  const raw = process.env.ADAPTIVE_DEMO_SLOTS?.trim() || DEFAULT_SLOTS;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const slot = part.trim();
    // A duplicate in the list would be handed out twice and the UNIQUE constraint would reject
    // the second claim, which looks like exhaustion rather than a typo. Drop them here instead.
    if (!slot || seen.has(slot)) continue;
    seen.add(slot);
    out.push(slot);
  }
  return out;
}

/** Existing mapping for an employee, if any. */
export async function mappingFor(employeeId: string): Promise<Mapping | undefined> {
  const r = await getPool().query(
    `SELECT bamboo_employee_id, workday_slot_id, employee_name, status, detail
       FROM ${S}.employee_workday_mapping WHERE bamboo_employee_id = $1`, [employeeId]);
  const x = r.rows[0];
  if (!x) return undefined;
  return {
    employeeId: String(x.bamboo_employee_id),
    slot: String(x.workday_slot_id),
    ...(x.employee_name ? { employeeName: String(x.employee_name) } : {}),
    status: x.status as Mapping["status"],
    ...(x.detail ? { detail: String(x.detail) } : {}),
  };
}

/**
 * Claim the first free slot for this employee, or return the one they already hold.
 *
 * Idempotent on `employeeId`: calling it ten times yields one slot. That is the guarantee the
 * brief asks for, and it is enforced by the primary key rather than by a check-then-act.
 *
 * Throws NoSlotsAvailable when the pool is exhausted. Deliberately an exception and not a null —
 * exhaustion must stop the pipeline loudly, because the alternative failure mode is writing over
 * somebody real.
 */
export async function claimSlot(
  employeeId: string, employeeName: string | undefined,
): Promise<{ mapping: Mapping; fresh: boolean }> {
  const existing = await mappingFor(employeeId);
  if (existing) return { mapping: existing, fresh: false };

  const pool = configuredSlots();
  if (pool.length === 0) {
    throw new Error("ADAPTIVE_DEMO_SLOTS is not configured — there is no pool to allocate from");
  }

  // One statement per attempt. `WITH ORDINALITY` preserves the configured order through the join
  // so the lowest unclaimed slot wins; `WHERE NOT EXISTS` excludes claimed ones; LIMIT 1 takes the
  // first.
  //
  // THE LOOP IS NOT DEFENSIVE PADDING. Two employees arriving together both see the same slot as
  // free — the SELECT is not serialised against the other transaction's INSERT — and the UNIQUE
  // constraint on workday_slot_id rejects the second. That is the constraint doing its job, and
  // the loser's correct response is to look again and take the next one. Without this retry the
  // concurrency test fails with
  //   duplicate key value violates unique constraint "employee_workday_mapping_workday_slot_id_key"
  // Bounded by the pool size: every attempt either succeeds or removes one candidate, so it
  // cannot spin.
  for (let attempt = 0; attempt < pool.length + 1; attempt += 1) {
    try {
      const r = await getPool().query(
        `INSERT INTO ${S}.employee_workday_mapping
           (bamboo_employee_id, workday_slot_id, employee_name, status)
         SELECT $1, candidate.slot, $2, 'CLAIMED'
           FROM unnest($3::text[]) WITH ORDINALITY AS candidate(slot, ord)
          WHERE NOT EXISTS (
            SELECT 1 FROM ${S}.employee_workday_mapping m WHERE m.workday_slot_id = candidate.slot)
          ORDER BY candidate.ord
          LIMIT 1
         ON CONFLICT (bamboo_employee_id) DO NOTHING
         RETURNING workday_slot_id`,
        [employeeId, employeeName ?? null, pool]);

      const slot = r.rows[0]?.workday_slot_id as string | undefined;
      if (slot) {
        return {
          mapping: {
            employeeId, slot,
            ...(employeeName ? { employeeName } : {}),
            status: "CLAIMED",
          },
          fresh: true,
        };
      }

      // No row inserted. Either this employee was claimed concurrently (ON CONFLICT swallowed it)
      // or the pool is full. Re-read to tell those apart rather than guessing.
      const afterRace = await mappingFor(employeeId);
      if (afterRace) return { mapping: afterRace, fresh: false };
      throw new NoSlotsAvailable(pool.length);
    } catch (e) {
      // 23505 = unique_violation. Only the slot key is retryable; the employee key means someone
      // else claimed for this same employee, which is a success for us once we re-read it.
      const code = (e as { code?: string }).code;
      if (code !== "23505") throw e;
      const mine = await mappingFor(employeeId);
      if (mine) return { mapping: mine, fresh: false };
      // Lost the slot to another employee — go round and take the next free one.
    }
  }
  throw new NoSlotsAvailable(pool.length);
}

export async function setMappingStatus(
  employeeId: string, status: Mapping["status"], detail?: string,
): Promise<void> {
  await getPool().query(
    `UPDATE ${S}.employee_workday_mapping
        SET status = $2, detail = $3, updated_at = now()
      WHERE bamboo_employee_id = $1`, [employeeId, status, detail ?? null]);
}

/**
 * The whole pool with its current state — what the Slot Monitor renders.
 *
 * Built from the CONFIGURED list left-joined onto claims, so an unclaimed member shows as
 * AVAILABLE and a claim whose slot has since been removed from configuration is still visible
 * (flagged) rather than silently vanishing.
 */
export async function slotMonitor(): Promise<{ slots: SlotRow[]; summary: Record<string, number>; orphaned: SlotRow[] }> {
  const pool = configuredSlots();
  const r = await getPool().query(
    `SELECT bamboo_employee_id, workday_slot_id, employee_name, status, detail, updated_at
       FROM ${S}.employee_workday_mapping`);
  const bySlot = new Map(r.rows.map((x) => [String(x.workday_slot_id), x]));

  const slots: SlotRow[] = pool.map((slot) => {
    const x = bySlot.get(slot);
    if (!x) return { slot, status: "AVAILABLE" as SlotStatus };
    return {
      slot,
      status: x.status as SlotStatus,
      employeeId: String(x.bamboo_employee_id),
      ...(x.employee_name ? { employeeName: String(x.employee_name) } : {}),
      ...(x.detail ? { detail: String(x.detail) } : {}),
      updatedAt: new Date(x.updated_at as string).toISOString(),
    };
  });

  const orphaned: SlotRow[] = [...bySlot.entries()]
    .filter(([slot]) => !pool.includes(slot))
    .map(([slot, x]) => ({
      slot,
      status: x.status as SlotStatus,
      employeeId: String(x.bamboo_employee_id),
      ...(x.employee_name ? { employeeName: String(x.employee_name) } : {}),
    }));

  const summary: Record<string, number> = { AVAILABLE: 0, CLAIMED: 0, SYNCING: 0, SYNCED: 0, FAILED: 0 };
  for (const s of slots) summary[s.status] = (summary[s.status] ?? 0) + 1;

  return { slots, summary, orphaned };
}
