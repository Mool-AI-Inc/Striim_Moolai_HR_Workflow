/**
 * UC5 celebrant selector — who has a birthday/anniversary on a given day.
 * @lifespan PRODUCTION — pure prod logic (leap-year rule, hire-year exclusion).
 * @responsibility Given today + employees, return the birthday/anniversary hits.
 */
import type { EmployeeRecord } from "../../platform/domain/types.js";

export type Occasion = "birthday" | "anniversary";
export interface CelebrantHit { employee: EmployeeRecord; occasion: Occasion; }

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function whoCelebratesOn(todayISO: string, employees: EmployeeRecord[]): CelebrantHit[] {
  const md = todayISO.slice(5);
  const year = Number(todayISO.slice(0, 4));
  const out: CelebrantHit[] = [];
  for (const e of employees) {
    if (e.status !== "A") continue;                                  // active-only
    let bMd = e.birthDate.slice(5);
    if (bMd === "02-29" && !isLeap(year)) bMd = "02-28";              // non-leap-year rule
    if (bMd === md) out.push({ employee: e, occasion: "birthday" });
    let aMd = e.hireDate.slice(5);
    if (aMd === "02-29" && !isLeap(year)) aMd = "02-28";             // same non-leap rule as birthdays (leap-day hires)
    if (aMd === md && Number(e.hireDate.slice(0, 4)) < year) {
      out.push({ employee: e, occasion: "anniversary" });            // excludes the hire year itself
    }
  }
  return out;
}
