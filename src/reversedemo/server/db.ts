/**
 * Postgres access for the reverse pipeline.
 * @lifespan PRODUCTION — all SQL for Workday -> BambooHR.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { guardPool, NEON_POOL_DEFAULTS } from "../../platform/db/poolGuard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = join(HERE, "..", "sql", "schema.sql");

/** Separate from the forward pipeline's schema so one cannot corrupt the other. */
const SCHEMA = (() => {
  const raw = (process.env.REVDEMO_SCHEMA ?? "revdemo").trim();
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(raw)) {
    throw new Error(`invalid REVDEMO_SCHEMA "${raw}"`);
  }
  return raw;
})();
const S = SCHEMA;
export const schemaName = SCHEMA;

export type Stage = "workday" | "striim" | "postgres" | "bamboohr";
export const STAGES: readonly Stage[] = ["workday", "striim", "postgres", "bamboohr"] as const;
export type StageStatus = "pending" | "processing" | "synced" | "failed";
export type LogLevel = "info" | "success" | "warn" | "error";

/** A person as Workday describes them. */
export interface WorkdayMember {
  memberId: string;
  workerName: string;
  gender?: string;
  location?: string;
  jobGroup?: string;
  jobClass?: string;
  levelCode?: string;
  payRate?: number;
}

/** The same person in our contract, ready for BambooHR. */
export interface MappedEmployee {
  memberId: string;
  firstName: string;
  lastName: string;
  email: string;
  jobTitle?: string;
  department?: string;
  location?: string;
  payRate?: number;
}

export interface StageRow { stage: Stage; status: StageStatus; detail: string | null; attempts: number }
export interface EventRow { id: string; at: string; memberId: string | null; stage: Stage | null; level: LogLevel; message: string }

let pool: Pool | undefined;
let targetPool: Pool | undefined;

export function getPool(databaseUrl?: string): Pool {
  if (!pool) {
    if (!databaseUrl) throw new Error("getPool() called before init");
    pool = guardPool(new Pool({ ...NEON_POOL_DEFAULTS, connectionString: databaseUrl }), "revdemo");
  }
  return pool;
}

/**
 * The database Striim REPLICATES INTO.
 *
 * A second connection, not a second schema, because the whole point is that the row has to
 * cross a database boundary by a route we do not control. If the BambooHR stage read the same
 * database the mapping was written to, Striim could be switched off and nothing would notice.
 */
export function getTargetPool(databaseUrl?: string): Pool {
  if (!targetPool) {
    if (!databaseUrl) throw new Error("getTargetPool() called before init");
    targetPool = guardPool(
      new Pool({ ...NEON_POOL_DEFAULTS, connectionString: databaseUrl }), "revdemo-target");
  }
  return targetPool;
}

/** Has Striim delivered this member to the target database yet? */
export async function targetHasMember(memberId: string): Promise<boolean> {
  const r = await getTargetPool().query(
    `SELECT 1 FROM revdemo.employees WHERE member_id = $1`, [memberId]);
  return (r.rowCount ?? 0) > 0;
}

export async function targetCount(): Promise<number> {
  const r = await getTargetPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM revdemo.employees`);
  return Number(r.rows[0]?.n ?? 0);
}

export async function closePool(): Promise<void> {
  if (pool) { await pool.end(); pool = undefined; }
  if (targetPool) { await targetPool.end(); targetPool = undefined; }
}

export async function migrate(databaseUrl: string): Promise<void> {
  const sql = readFileSync(SCHEMA_SQL, "utf8").replaceAll("__SCHEMA__", SCHEMA);
  await getPool(databaseUrl).query(sql);
}

// ── Workday landing ───────────────────────────────────────────────────────────────────────

export async function landMembers(members: WorkdayMember[]): Promise<number> {
  let n = 0;
  for (const m of members) {
    await getPool().query(
      `INSERT INTO ${S}.workday_landing
         (member_id, worker_name, gender, location, job_group, job_class, level_code, pay_rate, landed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (member_id) DO UPDATE SET
         worker_name = EXCLUDED.worker_name, gender = EXCLUDED.gender, location = EXCLUDED.location,
         job_group = EXCLUDED.job_group, job_class = EXCLUDED.job_class,
         level_code = EXCLUDED.level_code, pay_rate = EXCLUDED.pay_rate, landed_at = now()`,
      [m.memberId, m.workerName, m.gender ?? null, m.location ?? null, m.jobGroup ?? null,
       m.jobClass ?? null, m.levelCode ?? null, m.payRate ?? null]);
    n += 1;
  }
  return n;
}

export async function getLandedMember(memberId: string): Promise<WorkdayMember | undefined> {
  const r = await getPool().query(
    `SELECT member_id, worker_name, gender, location, job_group, job_class, level_code, pay_rate
       FROM ${S}.workday_landing WHERE member_id = $1`, [memberId]);
  const x = r.rows[0];
  if (!x) return undefined;
  return {
    memberId: String(x.member_id),
    workerName: String(x.worker_name ?? ""),
    ...(x.gender ? { gender: String(x.gender) } : {}),
    ...(x.location ? { location: String(x.location) } : {}),
    ...(x.job_group ? { jobGroup: String(x.job_group) } : {}),
    ...(x.job_class ? { jobClass: String(x.job_class) } : {}),
    ...(x.level_code ? { levelCode: String(x.level_code) } : {}),
    ...(x.pay_rate === null ? {} : { payRate: Number(x.pay_rate) }),
  };
}

export async function landingCount(): Promise<number> {
  const r = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.workday_landing`);
  return Number(r.rows[0]?.n ?? 0);
}

/** Candidates for import: landed in Workday, not yet mapped into BambooHR. */
export async function importable(limit = 200): Promise<(WorkdayMember & { mapped: boolean })[]> {
  const r = await getPool().query(
    `SELECT w.member_id, w.worker_name, w.location, w.job_group, w.job_class, w.pay_rate,
            (m.member_id IS NOT NULL) AS mapped
       FROM ${S}.workday_landing w
       LEFT JOIN ${S}.bamboohr_mapping m ON m.member_id = w.member_id
      ORDER BY w.member_id
      LIMIT $1`, [limit]);
  return r.rows.map((x) => ({
    memberId: String(x.member_id),
    workerName: String(x.worker_name ?? ""),
    ...(x.location ? { location: String(x.location) } : {}),
    ...(x.job_group ? { jobGroup: String(x.job_group) } : {}),
    ...(x.job_class ? { jobClass: String(x.job_class) } : {}),
    ...(x.pay_rate === null ? {} : { payRate: Number(x.pay_rate) }),
    mapped: Boolean(x.mapped),
  }));
}

// ── intermediate table ────────────────────────────────────────────────────────────────────

export async function upsertEmployee(e: MappedEmployee): Promise<void> {
  await getPool().query(
    `INSERT INTO ${S}.employees
       (member_id, first_name, last_name, email, job_title, department, location, pay_rate,
        sync_status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'processing', now())
     ON CONFLICT (member_id) DO UPDATE SET
       first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, email = EXCLUDED.email,
       job_title = EXCLUDED.job_title, department = EXCLUDED.department,
       location = EXCLUDED.location, pay_rate = EXCLUDED.pay_rate, updated_at = now()`,
    [e.memberId, e.firstName, e.lastName, e.email, e.jobTitle ?? null, e.department ?? null,
     e.location ?? null, e.payRate ?? null]);
}

export async function setSyncStatus(memberId: string, status: StageStatus): Promise<void> {
  await getPool().query(
    `UPDATE ${S}.employees SET sync_status = $2, updated_at = now() WHERE member_id = $1`,
    [memberId, status]);
}

export async function employeeCount(): Promise<number> {
  const r = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.employees`);
  return Number(r.rows[0]?.n ?? 0);
}

export async function listEmployees(limit = 50) {
  const r = await getPool().query(
    `SELECT e.member_id, e.first_name, e.last_name, e.email, e.job_title, e.department,
            e.location, e.pay_rate, e.sync_status, e.updated_at,
            m.bamboo_employee_id, m.status AS map_status, m.detail AS map_detail
       FROM ${S}.employees e
       LEFT JOIN ${S}.bamboohr_mapping m ON m.member_id = e.member_id
      ORDER BY e.created_at DESC LIMIT $1`, [limit]);
  return r.rows.map((x) => ({
    memberId: String(x.member_id),
    firstName: String(x.first_name), lastName: String(x.last_name), email: String(x.email),
    jobTitle: (x.job_title as string) ?? undefined,
    department: (x.department as string) ?? undefined,
    location: (x.location as string) ?? undefined,
    payRate: x.pay_rate === null ? undefined : Number(x.pay_rate),
    syncStatus: x.sync_status as StageStatus,
    bambooEmployeeId: (x.bamboo_employee_id as string) ?? undefined,
    mapStatus: (x.map_status as string) ?? undefined,
    mapDetail: (x.map_detail as string) ?? undefined,
    updatedAt: new Date(x.updated_at as string).toISOString(),
  }));
}

// ── BambooHR mapping ──────────────────────────────────────────────────────────────────────

/**
 * Reserve the intent to create this person, before any call to BambooHR.
 *
 * Returns false when a mapping already exists, which is the idempotency gate: a BambooHR create is
 * permanent and consumes a seat, so the expensive mistake is making two. Reserving FIRST means a
 * crash mid-create leaves a PENDING row that a retry can recognise, rather than no trace at all.
 */
export async function reserveMapping(memberId: string, email: string): Promise<boolean> {
  const r = await getPool().query(
    `INSERT INTO ${S}.bamboohr_mapping (member_id, email, status)
     VALUES ($1,$2,'PENDING') ON CONFLICT (member_id) DO NOTHING RETURNING member_id`,
    [memberId, email]);
  return r.rowCount === 1;
}

export async function setMapping(
  memberId: string, status: string, detail?: string, bambooEmployeeId?: string,
): Promise<void> {
  await getPool().query(
    `UPDATE ${S}.bamboohr_mapping
        SET status = $2, detail = $3,
            bamboo_employee_id = COALESCE($4, bamboo_employee_id), updated_at = now()
      WHERE member_id = $1`, [memberId, status, detail ?? null, bambooEmployeeId ?? null]);
}

export async function getMapping(memberId: string) {
  const r = await getPool().query(
    `SELECT member_id, bamboo_employee_id, email, status, detail
       FROM ${S}.bamboohr_mapping WHERE member_id = $1`, [memberId]);
  const x = r.rows[0];
  if (!x) return undefined;
  return {
    memberId: String(x.member_id),
    bambooEmployeeId: (x.bamboo_employee_id as string) ?? undefined,
    email: String(x.email),
    status: String(x.status),
    detail: (x.detail as string) ?? undefined,
  };
}

export async function mappingSummary(): Promise<Record<string, number>> {
  const r = await getPool().query(
    `SELECT status, count(*)::text AS n FROM ${S}.bamboohr_mapping GROUP BY status`);
  const out: Record<string, number> = { PENDING: 0, CREATING: 0, CREATED: 0, FAILED: 0 };
  for (const x of r.rows) out[String(x.status)] = Number(x.n);
  return out;
}

export async function createdCount(): Promise<number> {
  const r = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${S}.bamboohr_mapping WHERE status = 'CREATED'`);
  return Number(r.rows[0]?.n ?? 0);
}

// ── stages, events, idempotency ───────────────────────────────────────────────────────────

export async function setStage(
  memberId: string, stage: Stage, status: StageStatus, detail?: string, bump = false,
): Promise<void> {
  await getPool().query(
    `INSERT INTO ${S}.stage_state (member_id, stage, status, detail, attempts, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (member_id, stage) DO UPDATE SET
       status = EXCLUDED.status, detail = EXCLUDED.detail, updated_at = now(),
       attempts = ${S}.stage_state.attempts + $5`,
    [memberId, stage, status, detail ?? null, bump ? 1 : 0]);
}

export async function stagesFor(memberId: string): Promise<StageRow[]> {
  const r = await getPool().query(
    `SELECT stage, status, detail, attempts FROM ${S}.stage_state WHERE member_id = $1`, [memberId]);
  const by = new Map(r.rows.map((x) => [x.stage as Stage, x]));
  return STAGES.map((stage) => {
    const x = by.get(stage);
    return {
      stage,
      status: (x?.status as StageStatus) ?? "pending",
      detail: (x?.detail as string) ?? null,
      attempts: Number(x?.attempts ?? 0),
    };
  });
}

export async function allStages(): Promise<Record<string, StageRow[]>> {
  const r = await getPool().query(
    `SELECT member_id, stage, status, detail, attempts FROM ${S}.stage_state`);
  const out: Record<string, StageRow[]> = {};
  for (const x of r.rows) {
    const id = String(x.member_id);
    out[id] ??= STAGES.map((stage) => ({ stage, status: "pending" as StageStatus, detail: null, attempts: 0 }));
    const slot = out[id].find((s) => s.stage === x.stage);
    if (slot) {
      slot.status = x.status as StageStatus;
      slot.detail = (x.detail as string) ?? null;
      slot.attempts = Number(x.attempts ?? 0);
    }
  }
  return out;
}

export async function appendEvent(
  message: string, opts: { memberId?: string; stage?: Stage; level?: LogLevel } = {},
): Promise<EventRow> {
  const r = await getPool().query(
    `INSERT INTO ${S}.events (member_id, stage, level, message)
     VALUES ($1,$2,$3,$4) RETURNING id::text AS id, at, member_id, stage, level, message`,
    [opts.memberId ?? null, opts.stage ?? null, opts.level ?? "info", message]);
  const x = r.rows[0];
  return {
    id: String(x.id), at: new Date(x.at as string).toISOString(),
    memberId: (x.member_id as string) ?? null, stage: (x.stage as Stage) ?? null,
    level: x.level as LogLevel, message: String(x.message),
  };
}

export async function recentEvents(limit = 80): Promise<EventRow[]> {
  // Qualified ORDER BY e.id — `id::text AS id` creates a text output column that a bare
  // `ORDER BY id` would sort lexicographically (1, 10, 2, ...). Same trap as the forward pipeline.
  const r = await getPool().query(
    `SELECT e.id::text AS id, e.at, e.member_id, e.stage, e.level, e.message
       FROM ${S}.events e ORDER BY e.id DESC LIMIT $1`, [limit]);
  return r.rows.reverse().map((x) => ({
    id: String(x.id), at: new Date(x.at as string).toISOString(),
    memberId: (x.member_id as string) ?? null, stage: (x.stage as Stage) ?? null,
    level: x.level as LogLevel, message: String(x.message),
  }));
}

export async function claimStep(memberId: string, stage: Stage): Promise<boolean> {
  const r = await getPool().query(
    `INSERT INTO ${S}.processed_steps (step_key, member_id, stage)
     VALUES ($1,$2,$3) ON CONFLICT (step_key) DO NOTHING RETURNING step_key`,
    [`${memberId}:${stage}`, memberId, stage]);
  return r.rowCount === 1;
}

export async function releaseStep(memberId: string, stage: Stage): Promise<void> {
  await getPool().query(`DELETE FROM ${S}.processed_steps WHERE step_key = $1`, [`${memberId}:${stage}`]);
}

export async function ping(): Promise<boolean> {
  try { await getPool().query("SELECT 1"); return true; } catch { return false; }
}

/**
 * Clear local state only.
 *
 * It does NOT and cannot undo BambooHR creates — that API has no delete. Clearing the mapping
 * therefore makes previously-imported people importable again, which would create duplicates by
 * email... except BambooHR rejects duplicate emails, so the second attempt recovers the existing
 * id instead. Stated here because "reset" reads like "undo" and this one is not.
 */
export async function resetLocal(): Promise<void> {
  await getPool().query(
    `TRUNCATE ${S}.employees, ${S}.bamboohr_mapping, ${S}.stage_state, ${S}.events,
              ${S}.processed_steps, ${S}.workday_landing`);
}
