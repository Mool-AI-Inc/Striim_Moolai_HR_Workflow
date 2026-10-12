/**
 * UC4 selector — flag cost-center transitions for the monthly finance report.
 * @lifespan PRODUCTION — pure prod logic (no I/O).
 * @responsibility Given report rows already scoped to this month's hires, set isTransition: a row is a
 *   transition when priorCostCenter is present AND differs from the current costCenter.
 */
import type { FinanceReportRow } from "../../platform/domain/types.js";

export type UnflaggedRow = Omit<FinanceReportRow, "isTransition">;

export function flagTransitions(rows: UnflaggedRow[]): FinanceReportRow[] {
  return rows.map((r) => ({ ...r, isTransition: !!r.priorCostCenter && r.priorCostCenter !== r.costCenter }));
}
