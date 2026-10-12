/**
 * Push employees into BambooHR, idempotently.
 * @lifespan PRODUCTION — leg 2. Striim cannot write to any HR system, so this is ours.
 * @responsibility Create or update an employee and its table rows, exactly once each,
 *   resumably, and never twice.
 *
 * THE PROBLEM THIS SOLVES
 *
 * A migrated employee is not one API call. The core record is POST /employees/, but role,
 * pay and employment status are row-based history in SEPARATE tables, each its own POST.
 * There is no transaction across them. So a failure partway leaves a real person present in
 * the customer's HRIS with no job and no pay — and a naive retry creates a SECOND person,
 * with a second payroll record attached.
 *
 * Two tables make that impossible:
 *
 *   hris_id_map       source employee id -> the id BambooHR returned. Written the instant a
 *                     create succeeds. If a row exists, we NEVER post a create again.
 *   hris_load_ledger  one row per (employee, target). 'employee', 'jobInfo', 'compensation'
 *                     are tracked separately, because they succeed and fail separately.
 *
 * The ambiguous case is the dangerous one and is handled explicitly: if a create times out we
 * cannot know whether it landed. BambooHR rejects duplicate emails, so email is a usable
 * natural key — we look the person up before retrying rather than risking a duplicate human.
 */
import { Pool } from "pg";
import { BambooHRClient, type EmployeeFields, SeatLimitReached } from "./bamboohrClient.js";

const SYSTEM = "bamboohr";

export interface PushPlan {
  sourceEmployeeId: string;
  /** Core record. Minimum firstName + lastName. */
  employee: EmployeeFields;
  /** Row-based history: target name -> the row to append. */
  tables?: Record<string, EmployeeFields>;
}

export interface PushResult {
  sourceEmployeeId: string;
  remoteId?: string;
  created: boolean;
  targetsWritten: string[];
  targetsSkipped: string[];
  error?: string;
}

/** Test seam: fail deliberately at one target, to prove a resume does not duplicate. */
export interface PushOptions { failAtTarget?: string }

export class HrisLoader {
  constructor(
    private readonly pool: Pool,
    private readonly client: BambooHRClient,
  ) {}

  private async remoteId(sourceId: string): Promise<string | undefined> {
    const r = await this.pool.query<{ remote_id: string }>(
      `SELECT remote_id FROM hris_id_map WHERE source_employee_id = $1 AND system = $2`,
      [sourceId, SYSTEM]);
    return r.rows[0]?.remote_id;
  }

  private async mark(sourceId: string, target: string, state: string, error?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO hris_load_ledger (source_employee_id, system, target, state, attempts, last_error, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, now())
       ON CONFLICT (source_employee_id, system, target) DO UPDATE SET
         state = EXCLUDED.state,
         attempts = hris_load_ledger.attempts + 1,
         last_error = EXCLUDED.last_error,
         updated_at = now()`,
      [sourceId, SYSTEM, target, state, error ?? null]);
  }

  private async isSent(sourceId: string, target: string): Promise<boolean> {
    const r = await this.pool.query<{ state: string }>(
      `SELECT state FROM hris_load_ledger
        WHERE source_employee_id = $1 AND system = $2 AND target = $3`,
      [sourceId, SYSTEM, target]);
    return r.rows[0]?.state === "sent";
  }

  async push(plan: PushPlan, opts: PushOptions = {}): Promise<PushResult> {
    const out: PushResult = {
      sourceEmployeeId: plan.sourceEmployeeId, created: false,
      targetsWritten: [], targetsSkipped: [],
    };

    try {
      // ---- the core record -------------------------------------------------
      let id = await this.remoteId(plan.sourceEmployeeId);

      if (id) {
        // Already created. This is an UPDATE, never a create — the whole point.
        out.remoteId = id;
        if (await this.isSent(plan.sourceEmployeeId, "employee")) {
          out.targetsSkipped.push("employee");
        } else {
          await this.client.updateEmployee(id, plan.employee);
          await this.mark(plan.sourceEmployeeId, "employee", "sent");
          out.targetsWritten.push("employee");
        }
      } else {
        // No mapping. Before creating, check whether a previous run created them and lost
        // the response — BambooHR rejects duplicate emails, so email resolves it.
        const email = String(plan.employee.workEmail ?? "");
        const existing = email ? await this.client.findByEmail(email) : undefined;
        if (existing) {
          id = existing;
          await this.recordId(plan.sourceEmployeeId, id);
          await this.mark(plan.sourceEmployeeId, "employee", "sent");
          out.remoteId = id;
          out.targetsSkipped.push("employee (recovered by email — a previous run created it)");
        } else {
          if (opts.failAtTarget === "employee") throw new Error("injected failure at employee");
          id = await this.client.createEmployee(plan.employee);
          // Record the id BEFORE anything else can fail. If the process dies on the next
          // line, the mapping is already durable and no retry will create a second person.
          await this.recordId(plan.sourceEmployeeId, id);
          await this.mark(plan.sourceEmployeeId, "employee", "sent");
          out.remoteId = id;
          out.created = true;
          out.targetsWritten.push("employee");
        }
      }

      // ---- the table rows --------------------------------------------------
      for (const [target, row] of Object.entries(plan.tables ?? {})) {
        if (await this.isSent(plan.sourceEmployeeId, target)) {
          out.targetsSkipped.push(target);
          continue;
        }
        if (opts.failAtTarget === target) {
          await this.mark(plan.sourceEmployeeId, target, "failed", `injected failure at ${target}`);
          throw new Error(`injected failure at ${target}`);
        }
        await this.client.addTableRow(id, target, row);
        await this.mark(plan.sourceEmployeeId, target, "sent");
        out.targetsWritten.push(target);
      }
      return out;
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      out.error = err;
      // A seat cap is not a transient failure. Flag it for a person rather than retrying
      // forever against an account that has no room.
      if (e instanceof SeatLimitReached) {
        await this.mark(plan.sourceEmployeeId, "employee", "needs_human", err);
      }
      return out;
    }
  }

  private async recordId(sourceId: string, remoteId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO hris_id_map (source_employee_id, system, remote_id)
       VALUES ($1, $2, $3) ON CONFLICT (source_employee_id, system) DO NOTHING`,
      [sourceId, SYSTEM, remoteId]);
  }

  /** How many employees the account already holds, for a seat-limit preflight. */
  remoteHeadcount(): Promise<number> {
    return this.client.directorySize();
  }
}
