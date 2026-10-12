/**
 * UC8 selector — who starts tomorrow (the 24h-ahead Slack invite trigger).
 * @lifespan PRODUCTION — pure prod logic (deterministic date-only comparison).
 * @responsibility Given today + employees, return the active employees whose hireDate is tomorrow.
 */
import type { EmployeeRecord } from "../../platform/domain/types.js";

function tomorrowISO(todayISO: string): string {
  const d = new Date(`${todayISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function whoStartsTomorrow(todayISO: string, employees: EmployeeRecord[]): EmployeeRecord[] {
  const tomorrow = tomorrowISO(todayISO);
  return employees.filter((e) => e.status === "A" && e.hireDate === tomorrow);
}
