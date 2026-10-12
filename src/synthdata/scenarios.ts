/**
 * Demo-data loader + validity check + tiny test-row helpers.
 * @lifespan THROWAWAY — dev/test-only; the prod runtime reads real data via connectors, never this module.
 * @responsibility Load the committed fixture, assert its invariants, synthesize date-relative test rows.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EmployeeRecord } from "../platform/domain/types.js";
const YR = 365.25 * 864e5;
const FIXTURE = new URL("../../fixtures/employees.json", import.meta.url);

export function loadDemoEmployees(): EmployeeRecord[] {
  return JSON.parse(readFileSync(fileURLToPath(FIXTURE), "utf8")) as EmployeeRecord[];
}

export function findViolations(rows: EmployeeRecord[]): string[] {
  const v: string[] = []; const today = new Date().toISOString().slice(0, 10); const ids = new Set<string>();
  for (const r of rows) {
    if (ids.has(r.employeeId)) v.push(`duplicate id ${r.employeeId}`); ids.add(r.employeeId);
    if (!/^[^@\s]+@instantteams\.test$/.test(r.email)) v.push(`bad email ${r.email}`);
    if (r.hireDate > today) v.push(`future hireDate ${r.employeeId}`);
    if (new Date(r.hireDate).getTime() - new Date(r.birthDate).getTime() < 18 * YR) v.push(`hire<18y ${r.employeeId}`);
    if (!r.phone) v.push(`missing phone ${r.employeeId}`);
    if (typeof r.smsConsent !== "boolean") v.push(`bad smsConsent ${r.employeeId}`);
    if (r.priorCostCenter !== undefined && r.priorCostCenter === r.costCenter) v.push(`priorCostCenter==costCenter ${r.employeeId}`);  // a transition must actually differ — mirrors the Rockfish gate
  }
  return v;
}

export function makeEmployee(o: Partial<EmployeeRecord> = {}): EmployeeRecord {
  const base: EmployeeRecord = {
    employeeId: "E-TEST", firstName: "Test", lastName: "Person", email: "test.person@instantteams.test",
    birthDate: "1990-01-01", hireDate: "2022-01-01", employeeType: "RFT", status: "A", costCenter: "CC-OPS",
    phone: "+15555550100", smsConsent: true,
  };
  return { ...base, ...o };
}
export const employeeWithBirthdayOn = (dateISO: string): EmployeeRecord =>
  makeEmployee({ employeeId: `BD-${dateISO}`, birthDate: `1990${dateISO.slice(4)}` });
export const employeeWithAnniversaryOn = (dateISO: string): EmployeeRecord =>
  makeEmployee({ employeeId: `AN-${dateISO}`, hireDate: `2022${dateISO.slice(4)}` });
export const employeeStartingOn = (dateISO: string): EmployeeRecord =>
  makeEmployee({ employeeId: `ST-${dateISO}`, hireDate: dateISO });
