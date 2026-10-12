/**
 * The employees table — the bulk historical load the migration moves.
 * @lifespan PRODUCTION — read by the simulator and the demo picker once LEDGER_MODE=pg.
 * @responsibility Upsert from EmployeeRecord, list, count. Nothing else reads this table.
 */
import { getPool } from "./pool.js";
import type { EmployeeRecord } from "../domain/types.js";

interface Row {
  employee_id: string; first_name: string; last_name: string; email: string;
  birth_date: Date | string | null; hire_date: Date | string | null;
  employee_type: string; status: string; cost_center: string;
  prior_cost_center: string | null; phone: string; sms_consent: boolean;
}

const iso = (d: Date | string | null): string => {
  if (!d) return "";
  return typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);
};

const toRecord = (r: Row): EmployeeRecord => ({
  employeeId: r.employee_id, firstName: r.first_name, lastName: r.last_name, email: r.email,
  birthDate: iso(r.birth_date), hireDate: iso(r.hire_date),
  employeeType: r.employee_type as EmployeeRecord["employeeType"],
  status: r.status as EmployeeRecord["status"],
  costCenter: r.cost_center, phone: r.phone, smsConsent: r.sms_consent,
  ...(r.prior_cost_center ? { priorCostCenter: r.prior_cost_center } : {}),
});

const COLUMNS = `employee_id, first_name, last_name, email, birth_date, hire_date,
                 employee_type, status, cost_center, prior_cost_center, phone, sms_consent`;

export async function upsertEmployee(e: EmployeeRecord): Promise<void> {
  await getPool().query(
    `INSERT INTO employees (${COLUMNS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (employee_id) DO UPDATE SET
       first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
       email = EXCLUDED.email, birth_date = EXCLUDED.birth_date, hire_date = EXCLUDED.hire_date,
       employee_type = EXCLUDED.employee_type, status = EXCLUDED.status,
       cost_center = EXCLUDED.cost_center, prior_cost_center = EXCLUDED.prior_cost_center,
       phone = EXCLUDED.phone, sms_consent = EXCLUDED.sms_consent, updated_at = now()`,
    [e.employeeId, e.firstName, e.lastName, e.email, e.birthDate || null, e.hireDate || null,
     e.employeeType, e.status, e.costCenter, e.priorCostCenter ?? null, e.phone, e.smsConsent],
  );
}

/** The same columns, qualified, for the join in bamboohr mode. */
const COLUMNS_E = COLUMNS.split(",").map((c) => `e.${c.trim()}`).join(", ");

/**
 * Who appears in the demo picker.
 *
 *   ROSTER_SOURCE=bamboohr   (default) only people the CURRENT BambooHR tenant lists
 *   ROSTER_SOURCE=all                  the whole table, fixture population included
 *   ROSTER_LIMIT=10          (default) cap; 0 or "all" means no cap
 *
 * Two reasons for that default rather than showing the table as it stands:
 *
 * 1. The table deliberately holds two populations — 112 people from BambooHR and 201
 *    synthetic `EMP_*` rows loaded from fixtures/employees.json. Mixed into one dropdown
 *    there is no way to tell which is which, so "is this real data?" has no answerable
 *    response. The join to bamboohr_employees is the honest filter: someone appears only if
 *    the live tenant's directory still lists them, which also excludes leftovers from an
 *    expired trial.
 * 2. A picker with 313 names is unusable.
 *
 * The fixture rows are NOT deleted, and must not be: pending_approvals and send_ledger
 * reference them, and they are most of the bulk the migration exists to move. This filters
 * what is DISPLAYED and nothing else. ROSTER_SOURCE=all shows everything again.
 *
 * hire_date and birth_date are required because UC2a/UC2b anchor the Day-60 timer on the
 * first and UC5 matches birthdays on the second — a picker entry that cannot finish its own
 * arc is a trap. All 92 currently-listed BambooHR people satisfy both.
 */
export async function listEmployees(): Promise<EmployeeRecord[]> {
  const source = (process.env.ROSTER_SOURCE ?? "bamboohr").trim().toLowerCase();
  const rawLimit = (process.env.ROSTER_LIMIT ?? "10").trim().toLowerCase();
  const parsed = rawLimit === "all" || rawLimit === "0" ? NaN : Number(rawLimit);
  const cap = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;

  if (source === "bamboohr") {
    try {
      const r = await getPool().query<Row>(
        `SELECT ${COLUMNS_E}
           FROM employees e
           JOIN bamboohr_employees b ON b.id = e.employee_id
          WHERE e.status = 'A'
            AND e.hire_date IS NOT NULL
            AND e.birth_date IS NOT NULL
          -- DESCENDING, and this matters. BambooHR assigns the next free id to a new employee,
          -- so someone added by hand gets the HIGHEST id in the tenant. Ascending order plus a
          -- LIMIT put them off the end of the list — the one person you added in order to
          -- demonstrate the live feed would be the one person the picker could not show.
          -- Newest first also means the demo's "watch them appear" beat needs no scrolling.
          ORDER BY (e.employee_id)::int DESC
          ${cap ? `LIMIT ${cap}` : ""}`);
      if (r.rows.length) return r.rows.map(toRecord);
      console.warn("[roster] no BambooHR employees matched — is the Striim landing table populated? "
                 + "Falling back to the full table; set ROSTER_SOURCE=all to silence this.");
    } catch (e) {
      // bamboohr_employees is created by Striim's BambooHRReader (MigrateSchema: true), so on a
      // machine that has never run leg 1 it does not exist at all. Name the cause rather than
      // failing the whole picker.
      console.warn(`[roster] bamboohr filter unavailable (${e instanceof Error ? e.message : String(e)})`
                 + " — falling back to the full table.");
    }
  }

  const r = await getPool().query<Row>(
    `SELECT ${COLUMNS} FROM employees ORDER BY employee_id ${cap ? `LIMIT ${cap}` : ""}`);
  return r.rows.map(toRecord);
}

export async function getEmployee(employeeId: string): Promise<EmployeeRecord | undefined> {
  const r = await getPool().query<Row>(
    `SELECT ${COLUMNS} FROM employees WHERE employee_id = $1`, [employeeId]);
  return r.rows[0] ? toRecord(r.rows[0]) : undefined;
}

export async function countEmployees(): Promise<number> {
  const r = await getPool().query<{ n: string }>(`SELECT count(*)::bigint AS n FROM employees`);
  return Number(r.rows[0]?.n ?? 0);
}
