/**
 * UC3 selector — build the personnel-file checklist from what's required vs. what arrived.
 * @lifespan PRODUCTION — pure prod logic (no I/O).
 * @responsibility Given the required doc set, which of them arrived, and the employee, return the
 *   PersonnelChecklist (arrived vs missing, in required-doc order). Never files a doc that didn't arrive —
 *   this function only ever reports on what the workflow already decided to file.
 */
import type { PersonnelChecklist } from "../../platform/domain/types.js";

export const REQUIRED_DOCS = ["background-check", "i-9"] as const;

export function buildChecklist(required: readonly string[], arrived: readonly string[], employeeId: string): PersonnelChecklist {
  const arrivedSet = new Set(arrived);
  return {
    employeeId,
    arrived: required.filter((d) => arrivedSet.has(d)),
    missing: required.filter((d) => !arrivedSet.has(d)),
  };
}
