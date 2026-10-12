/**
 * Postgres access for the sync demo.
 * @lifespan PRODUCTION — pool, migration, and every query the pipeline and API make.
 * @responsibility All SQL. Nothing above this file writes a query.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { guardPool, NEON_POOL_DEFAULTS } from "../../platform/db/poolGuard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = join(HERE, "..", "sql", "schema.sql");
const SLOTS_SQL = join(HERE, "..", "sql", "slots.sql");

/**
 * Which Postgres schema this instance owns. Default `syncdemo`.
 *
 * Configurable because the test suite has to be able to run against the SAME database as a
 * running dev server without the two fighting. They did fight: the server's 1.5s poller processed
 * the tests' records, and because the fault switches are per-process the server cheerfully
 * completed a pipeline the test had deliberately broken. Separate schemas make the isolation real
 * rather than a rule someone has to remember.
 *
 * Validated, not interpolated blindly — this value reaches SQL as an identifier.
 */
const SCHEMA = (() => {
  const raw = (process.env.SYNCDEMO_SCHEMA ?? "syncdemo").trim();
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(raw)) {
    throw new Error(`invalid SYNCDEMO_SCHEMA "${raw}" — lower-case letters, digits and underscore only`);
  }
  return raw;
})();

export const schemaName = SCHEMA;
const S = SCHEMA;

export type Stage = "bamboohr" | "striim" | "postgres" | "workday";
export const STAGES: readonly Stage[] = ["bamboohr", "striim", "postgres", "workday"] as const;

export type StageStatus = "pending" | "processing" | "synced" | "failed";
export type LogLevel = "info" | "success" | "warn" | "error";

export interface EmployeeInput {
  employeeId: string;
  firstName: string;
  lastName: string;
  email: string;
  jobTitle?: string;
  department?: string;
  location?: string;
  phone?: string;
  hireDate?: string;
  /**
   * The figure that actually reaches Adaptive. "PY Pay" is the ONLY writable column on
   * the EUPTD import template — Headcount, Salary, Taxes, Tenure in Months and Total
   * Compensation are each rejected with "Invalid header name(s)" — so this is not an
   * optional nicety, it is the payload.
   */
  payRate?: number;
}

export interface EmployeeRow extends EmployeeInput {
  sourceSystem: string;
  createdAt: string;
  updatedAt: string;
  syncStatus: StageStatus;
}

export interface StageRow { stage: Stage; status: StageStatus; detail: string | null; attempts: number; updatedAt: string }
export interface EventRow { id: string; at: string; employeeId: string | null; stage: Stage | null; level: LogLevel; message: string }

let pool: Pool | undefined;

export function getPool(databaseUrl?: string): Pool {
  if (!pool) {
    if (!databaseUrl) throw new Error("getPool() called before init");
    // guardPool is not optional on Neon: an idle connection dropped by the server raises an
    // unhandled 'error' event on the pool and takes the process down with it.
    pool = guardPool(new Pool({ ...NEON_POOL_DEFAULTS, connectionString: databaseUrl }), "syncdemo");
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) { await pool.end(); pool = undefined; }
}

/** Create the schema. Idempotent, so it runs on every boot rather than needing a migrate step. */
export async function migrate(databaseUrl: string): Promise<void> {
  // Both files, in order, so a fresh database gets the schema before the tables in it.
  for (const file of [SCHEMA_SQL, SLOTS_SQL]) {
    const sql = readFileSync(file, "utf8").replaceAll("__SCHEMA__", SCHEMA);
    await getPool(databaseUrl).query(sql);
  }
}

// ── source system (mock BambooHR) ─────────────────────────────────────────────────────────

/** Insert into the mock BambooHR store and bump its revision, the way a save in an HRIS would. */
export async function mockBambooUpsert(e: EmployeeInput): Promise<number> {
  const r = await getPool().query<{ revision: string }>(
    `INSERT INTO ${S}.mock_bamboohr_employees
       (employee_id, first_name, last_name, email, job_title, department, location, phone, hire_date, pay_rate, revision)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, nextval('${S}.mock_bamboohr_revision_seq'))
     ON CONFLICT (employee_id) DO UPDATE SET
       first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, email = EXCLUDED.email,
       job_title = EXCLUDED.job_title, department = EXCLUDED.department, location = EXCLUDED.location,
       phone = EXCLUDED.phone, hire_date = EXCLUDED.hire_date, pay_rate = EXCLUDED.pay_rate,
       revision = nextval('${S}.mock_bamboohr_revision_seq')
     RETURNING revision`,
    [e.employeeId, e.firstName, e.lastName, e.email, e.jobTitle ?? null, e.department ?? null,
     e.location ?? null, e.phone ?? null, e.hireDate ?? null, e.payRate ?? null]);
  return Number(r.rows[0]?.revision ?? 0);
}

export async function mockBambooCount(): Promise<number> {
  const r = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.mock_bamboohr_employees`);
  return Number(r.rows[0]?.n ?? 0);
}

export async function mockBambooFindByEmail(email: string): Promise<string | undefined> {
  const r = await getPool().query<{ employee_id: string }>(
    `SELECT employee_id FROM ${S}.mock_bamboohr_employees WHERE lower(email) = lower($1)`, [email]);
  return r.rows[0]?.employee_id;
}

/** Rows the change-poller has not seen yet. This is the mock's CDC read. */
export async function mockBambooChangesSince(revision: number): Promise<(EmployeeInput & { revision: number })[]> {
  const r = await getPool().query(
    `SELECT employee_id, first_name, last_name, email, job_title, department, location, phone,
            to_char(hire_date, 'YYYY-MM-DD') AS hire_date, pay_rate, revision
       FROM ${S}.mock_bamboohr_employees
      WHERE revision > $1
      ORDER BY revision ASC`, [revision]);
  return r.rows.map((x) => ({
    employeeId: x.employee_id, firstName: x.first_name, lastName: x.last_name, email: x.email,
    jobTitle: x.job_title ?? undefined, department: x.department ?? undefined,
    location: x.location ?? undefined, phone: x.phone ?? undefined,
    hireDate: x.hire_date ?? undefined,
    ...(x.pay_rate === null || x.pay_rate === undefined ? {} : { payRate: Number(x.pay_rate) }),
    revision: Number(x.revision),
  }));
}

export async function getWatermark(): Promise<number> {
  const r = await getPool().query<{ revision: string }>(`SELECT revision::text FROM ${S}.striim_watermark WHERE id = 1`);
  return Number(r.rows[0]?.revision ?? 0);
}

export async function setWatermark(revision: number): Promise<void> {
  await getPool().query(
    `UPDATE ${S}.striim_watermark SET revision = GREATEST(revision, $1) WHERE id = 1`, [revision]);
}

// ── Striim landing table ──────────────────────────────────────────────────────────────────

export async function landRow(employeeId: string, payload: unknown, revision: number): Promise<void> {
  await getPool().query(
    `INSERT INTO ${S}.landing (employee_id, payload, revision, landed_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (employee_id) DO UPDATE SET
       payload = EXCLUDED.payload, revision = EXCLUDED.revision, landed_at = now()`,
    [employeeId, JSON.stringify(payload), revision]);
}

export async function getLanding(employeeId: string): Promise<{ payload: EmployeeInput; revision: number } | undefined> {
  const r = await getPool().query<{ payload: EmployeeInput; revision: string }>(
    `SELECT payload, revision::text FROM ${S}.landing WHERE employee_id = $1`, [employeeId]);
  const row = r.rows[0];
  return row ? { payload: row.payload, revision: Number(row.revision) } : undefined;
}

export async function landingCount(): Promise<number> {
  const r = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.landing`);
  return Number(r.rows[0]?.n ?? 0);
}

// ── the intermediate database ─────────────────────────────────────────────────────────────

/** The mapping step: landing row -> the table the website reads. Idempotent by employee_id. */
export async function upsertEmployee(e: EmployeeInput, sourceSystem: string): Promise<void> {
  await getPool().query(
    `INSERT INTO ${S}.employees
       (employee_id, first_name, last_name, email, job_title, department, location, phone,
        hire_date, pay_rate, source_system, sync_status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'processing', now())
     ON CONFLICT (employee_id) DO UPDATE SET
       first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, email = EXCLUDED.email,
       job_title = EXCLUDED.job_title, department = EXCLUDED.department,
       location = EXCLUDED.location, phone = EXCLUDED.phone, hire_date = EXCLUDED.hire_date,
       pay_rate = COALESCE(EXCLUDED.pay_rate, ${S}.employees.pay_rate),
       source_system = EXCLUDED.source_system, updated_at = now()`,
    [e.employeeId, e.firstName, e.lastName, e.email, e.jobTitle ?? null, e.department ?? null,
     e.location ?? null, e.phone ?? null, e.hireDate ?? null, e.payRate ?? null, sourceSystem]);
}

export async function setEmployeeSyncStatus(employeeId: string, status: StageStatus): Promise<void> {
  await getPool().query(
    `UPDATE ${S}.employees SET sync_status = $2, updated_at = now() WHERE employee_id = $1`,
    [employeeId, status]);
}

const EMP_SELECT = `employee_id, first_name, last_name, email, job_title, department, location,
                    phone, to_char(hire_date,'YYYY-MM-DD') AS hire_date, pay_rate, source_system,
                    created_at, updated_at, sync_status`;

const toEmployee = (x: Record<string, unknown>): EmployeeRow => ({
  employeeId: String(x.employee_id), firstName: String(x.first_name), lastName: String(x.last_name),
  email: String(x.email),
  jobTitle: (x.job_title as string) ?? undefined, department: (x.department as string) ?? undefined,
  location: (x.location as string) ?? undefined, phone: (x.phone as string) ?? undefined,
  hireDate: (x.hire_date as string) ?? undefined,
  ...(x.pay_rate === null || x.pay_rate === undefined ? {} : { payRate: Number(x.pay_rate) }),
  sourceSystem: String(x.source_system),
  createdAt: new Date(x.created_at as string).toISOString(),
  updatedAt: new Date(x.updated_at as string).toISOString(),
  syncStatus: x.sync_status as StageStatus,
});

export async function listEmployees(limit = 50): Promise<EmployeeRow[]> {
  const r = await getPool().query(
    `SELECT ${EMP_SELECT} FROM ${S}.employees ORDER BY created_at DESC LIMIT $1`, [limit]);
  return r.rows.map(toEmployee);
}

export async function getEmployee(employeeId: string): Promise<EmployeeRow | undefined> {
  const r = await getPool().query(
    `SELECT ${EMP_SELECT} FROM ${S}.employees WHERE employee_id = $1`, [employeeId]);
  return r.rows[0] ? toEmployee(r.rows[0]) : undefined;
}

export async function employeeCount(): Promise<number> {
  const r = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.employees`);
  return Number(r.rows[0]?.n ?? 0);
}

export async function latestEmployee(): Promise<EmployeeRow | undefined> {
  const r = await getPool().query(
    `SELECT ${EMP_SELECT} FROM ${S}.employees ORDER BY created_at DESC LIMIT 1`);
  return r.rows[0] ? toEmployee(r.rows[0]) : undefined;
}

// ── mock Workday store ────────────────────────────────────────────────────────────────────

export async function mockWorkdayUpsert(e: EmployeeInput, workerId: string): Promise<{ workerId: string; created: boolean }> {
  const r = await getPool().query<{ worker_id: string; created: boolean }>(
    `INSERT INTO ${S}.mock_workday_workers
       (worker_id, employee_id, legal_name, email, position, cost_center, location, hire_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (employee_id) DO UPDATE SET
       legal_name = EXCLUDED.legal_name, email = EXCLUDED.email, position = EXCLUDED.position,
       cost_center = EXCLUDED.cost_center, location = EXCLUDED.location,
       hire_date = EXCLUDED.hire_date, updated_at = now()
     RETURNING worker_id, (xmax = 0) AS created`,
    [workerId, e.employeeId, `${e.firstName} ${e.lastName}`.trim(), e.email,
     e.jobTitle ?? null, e.department ?? null, e.location ?? null, e.hireDate ?? null]);
  const row = r.rows[0];
  return { workerId: row?.worker_id ?? workerId, created: Boolean(row?.created) };
}

export async function mockWorkdayCount(): Promise<number> {
  const r = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.mock_workday_workers`);
  return Number(r.rows[0]?.n ?? 0);
}

export async function mockWorkdayGet(employeeId: string) {
  const r = await getPool().query(
    `SELECT worker_id, employee_id, legal_name, email, position, cost_center, location,
            to_char(hire_date,'YYYY-MM-DD') AS hire_date, updated_at
       FROM ${S}.mock_workday_workers WHERE employee_id = $1`, [employeeId]);
  return r.rows[0];
}

export async function mockWorkdayLatest() {
  const r = await getPool().query(
    `SELECT worker_id, employee_id, legal_name, updated_at
       FROM ${S}.mock_workday_workers ORDER BY updated_at DESC LIMIT 1`);
  return r.rows[0];
}

// ── bootstrap guard (live mode) ───────────────────────────────────────────────────────────

/**
 * Record everything already in the real Striim landing table, once, so the first live poll does
 * not treat the entire existing workforce as a batch of new hires.
 *
 * Returns how many were marked. Zero means it had already been done — this is deliberately
 * idempotent, because it runs on every start.
 */
export async function bootstrapSkipExisting(): Promise<number> {
  const already = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${S}.bootstrap_skip`);
  if (Number(already.rows[0]?.n ?? 0) > 0) return 0;
  const r = await getPool().query(
    `INSERT INTO ${S}.bootstrap_skip (employee_id)
     SELECT id FROM public.bamboohr_employees
     ON CONFLICT (employee_id) DO NOTHING`);
  return r.rowCount ?? 0;
}

export async function bootstrapSkipCount(): Promise<number> {
  const r = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.bootstrap_skip`);
  return Number(r.rows[0]?.n ?? 0);
}

// ── live Workday bookkeeping ──────────────────────────────────────────────────────────────

export async function recordWorkdaySync(employeeId: string, workerRef: string, detail: string): Promise<void> {
  await getPool().query(
    `INSERT INTO ${S}.workday_synced (employee_id, worker_ref, detail, synced_at)
     VALUES ($1,$2,$3, now())
     ON CONFLICT (employee_id) DO UPDATE SET
       worker_ref = EXCLUDED.worker_ref, detail = EXCLUDED.detail, synced_at = now()`,
    [employeeId, workerRef, detail]);
}

export async function workdaySyncedCount(): Promise<number> {
  const r = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.workday_synced`);
  return Number(r.rows[0]?.n ?? 0);
}

export async function workdaySyncedLatest(): Promise<{ label: string; at: string } | undefined> {
  const r = await getPool().query(
    `SELECT w.employee_id, w.worker_ref, w.synced_at, e.first_name, e.last_name
       FROM ${S}.workday_synced w
       LEFT JOIN ${S}.employees e ON e.employee_id = w.employee_id
      ORDER BY w.synced_at DESC LIMIT 1`);
  const x = r.rows[0];
  if (!x) return undefined;
  const name = [x.first_name, x.last_name].filter(Boolean).join(" ");
  return {
    label: `${x.employee_id}${name ? ` · ${name}` : ""} (${x.worker_ref})`,
    at: new Date(x.synced_at as string).toISOString(),
  };
}

// ── stage state ───────────────────────────────────────────────────────────────────────────

export async function setStage(
  employeeId: string, stage: Stage, status: StageStatus, detail?: string, bumpAttempt = false,
): Promise<void> {
  await getPool().query(
    `INSERT INTO ${S}.stage_state (employee_id, stage, status, detail, attempts, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (employee_id, stage) DO UPDATE SET
       status = EXCLUDED.status, detail = EXCLUDED.detail, updated_at = now(),
       attempts = ${S}.stage_state.attempts + $5`,
    [employeeId, stage, status, detail ?? null, bumpAttempt ? 1 : 0]);
}

export async function stagesFor(employeeId: string): Promise<StageRow[]> {
  const r = await getPool().query(
    `SELECT stage, status, detail, attempts, updated_at FROM ${S}.stage_state
      WHERE employee_id = $1`, [employeeId]);
  const byStage = new Map(r.rows.map((x) => [x.stage as Stage, x]));
  // Always return all four, so the UI never has to guess what a missing row means.
  return STAGES.map((stage) => {
    const x = byStage.get(stage);
    return {
      stage,
      status: (x?.status as StageStatus) ?? "pending",
      detail: (x?.detail as string) ?? null,
      attempts: Number(x?.attempts ?? 0),
      updatedAt: x ? new Date(x.updated_at as string).toISOString() : "",
    };
  });
}

export async function allStages(): Promise<Record<string, StageRow[]>> {
  const r = await getPool().query(
    `SELECT employee_id, stage, status, detail, attempts, updated_at FROM ${S}.stage_state`);
  const out: Record<string, StageRow[]> = {};
  for (const x of r.rows) {
    const id = String(x.employee_id);
    out[id] ??= STAGES.map((stage) => ({ stage, status: "pending" as StageStatus, detail: null, attempts: 0, updatedAt: "" }));
    const slot = out[id].find((s) => s.stage === x.stage);
    if (slot) {
      slot.status = x.status as StageStatus;
      slot.detail = (x.detail as string) ?? null;
      slot.attempts = Number(x.attempts ?? 0);
      slot.updatedAt = new Date(x.updated_at as string).toISOString();
    }
  }
  return out;
}

// ── activity log ──────────────────────────────────────────────────────────────────────────

export async function appendEvent(
  message: string, opts: { employeeId?: string; stage?: Stage; level?: LogLevel } = {},
): Promise<EventRow> {
  const r = await getPool().query(
    `INSERT INTO ${S}.events (employee_id, stage, level, message)
     VALUES ($1,$2,$3,$4) RETURNING id::text, at, employee_id, stage, level, message`,
    [opts.employeeId ?? null, opts.stage ?? null, opts.level ?? "info", message]);
  const x = r.rows[0];
  return {
    id: String(x.id), at: new Date(x.at as string).toISOString(),
    employeeId: (x.employee_id as string) ?? null, stage: (x.stage as Stage) ?? null,
    level: x.level as LogLevel, message: String(x.message),
  };
}

export async function recentEvents(limit = 80): Promise<EventRow[]> {
  // ORDER BY e.id, qualified — not ORDER BY id.
  //
  // `id::text` produces an OUTPUT column also called `id`, and Postgres resolves a bare ORDER BY
  // name against the output list before the table's columns. So `ORDER BY id DESC` sorted the
  // TEXT, lexicographically: 9, 8, 7, ..., 10, 1. After the reverse the log read 1, 10, 2, 3 —
  // the newest line appearing second. The rows in the table were always in the right order; the
  // query was the thing scrambling them.
  const r = await getPool().query(
    `SELECT e.id::text, e.at, e.employee_id, e.stage, e.level, e.message
       FROM ${S}.events e
      ORDER BY e.id DESC LIMIT $1`, [limit]);
  return r.rows.reverse().map((x) => ({
    id: String(x.id), at: new Date(x.at as string).toISOString(),
    employeeId: (x.employee_id as string) ?? null, stage: (x.stage as Stage) ?? null,
    level: x.level as LogLevel, message: String(x.message),
  }));
}

export async function eventCount(): Promise<number> {
  const r = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.events`);
  return Number(r.rows[0]?.n ?? 0);
}

// ── idempotency ───────────────────────────────────────────────────────────────────────────

/**
 * Claim a step. Returns false if this exact step has already run.
 *
 * The key is deterministic — employee + stage + revision — so a redelivered change, a double
 * click, and a retry of an already-succeeded stage all collapse onto the same row. INSERT ..
 * ON CONFLICT DO NOTHING makes the claim atomic, so two concurrent pollers cannot both win.
 */
export async function claimStep(employeeId: string, stage: Stage, revision: number): Promise<boolean> {
  const key = `${employeeId}:${stage}:${revision}`;
  const r = await getPool().query(
    `INSERT INTO ${S}.processed_steps (step_key, employee_id, stage)
     VALUES ($1,$2,$3) ON CONFLICT (step_key) DO NOTHING RETURNING step_key`,
    [key, employeeId, stage]);
  return r.rowCount === 1;
}

/** Release a claim so a failed stage can genuinely be retried. */
export async function releaseStep(employeeId: string, stage: Stage, revision: number): Promise<void> {
  await getPool().query(`DELETE FROM ${S}.processed_steps WHERE step_key = $1`,
    [`${employeeId}:${stage}:${revision}`]);
}

/** Is Postgres reachable? Used by the dashboard's connection indicator. */
export async function ping(): Promise<boolean> {
  try { await getPool().query("SELECT 1"); return true; } catch { return false; }
}

export async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try { return await fn(c); } finally { c.release(); }
}

export async function resetDemo(): Promise<void> {
  await getPool().query(
    `TRUNCATE ${S}.employees, ${S}.landing, ${S}.stage_state, ${S}.events,
              ${S}.processed_steps, ${S}.mock_bamboohr_employees,
              ${S}.mock_workday_workers, ${S}.workday_synced, ${S}.bootstrap_skip,
              ${S}.employee_workday_mapping`);
  await getPool().query(`UPDATE ${S}.striim_watermark SET revision = 0 WHERE id = 1`);
}
