/**
 * One-shot demo-data generator (fallback; the Rockfish plan produces the canonical fixture).
 * @lifespan THROWAWAY — dev-only; run once, commit the JSON, delete-able thereafter.
 * @responsibility Encode realistic distributions/constraints, calibrate ratios, gate on validity, write fixtures/employees.json.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { faker, fakerEN_US } from "@faker-js/faker";
import type { EmployeeRecord } from "../src/platform/domain/types.js";
import { findViolations } from "../src/synthdata/scenarios.js";

const N = 25, SEED = 20260818, YR = 365.25 * 864e5;
const FOUNDED = new Date("2015-01-01").getTime();
const CENTERS = ["CC-RETAIL", "CC-OPS", "CC-CX", "CC-ENG"] as const;
const RATIOS = { employeeType: { RFT: 0.72, RPT: 0.20, SNL: 0.08 }, status: { A: 0.90, L: 0.05, T: 0.05 } } as const;

faker.seed(SEED); fakerEN_US.seed(SEED);
let s = SEED >>> 0;
const rng = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T extends string>(pairs: readonly (readonly [T, number])[]): T => {
  const x = rng(); let acc = 0; for (const [v, w] of pairs) { acc += w; if (x < acc) return v; } return pairs[pairs.length - 1][0];
};
const dateYearsAgo = (min: number, max: number) => new Date(Date.now() - (min + rng() * (max - min)) * YR).toISOString().slice(0, 10);

// 1) generate (weighted categoricals = the biggest realism lever)
const today = new Date().toISOString().slice(0, 10);
const seen = new Set<string>();
let rows: EmployeeRecord[] = Array.from({ length: N }, (_, i) => {
  const firstName = faker.person.firstName(), lastName = faker.person.lastName();
  let email = `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z.]/g, "") + "@instantteams.test";
  while (seen.has(email)) email = email.replace("@", `${i}@`); seen.add(email);
  const costCenter = pick([["CC-RETAIL", 0.4], ["CC-OPS", 0.3], ["CC-CX", 0.2], ["CC-ENG", 0.1]] as const);
  const priorCostCenter = rng() < 0.15 ? CENTERS.filter((c) => c !== costCenter)[Math.floor(rng() * 3)] : undefined; // ~15% transition cohort (UC4)
  return {
    employeeId: `EMP_${i + 1}`, firstName, lastName, email,
    birthDate: dateYearsAgo(22, 65), hireDate: dateYearsAgo(0, 6),
    employeeType: pick([["RFT", 0.72], ["RPT", 0.20], ["SNL", 0.08]] as const),
    status: pick([["A", 0.90], ["L", 0.05], ["T", 0.05]] as const),
    costCenter,
    phone: fakerEN_US.phone.number({ style: "national" }),   // seeded
    smsConsent: rng() < 0.7,                                  // ~70% consenting
    ...(priorCostCenter ? { priorCostCenter } : {}),
  };
});

// 2) constrain: hire >= 18th birthday (+1-day margin so a clamped row lands STRICTLY past the validator's
//    18*365.25-day threshold after the date is truncated to YYYY-MM-DD — matches the Rockfish finish pass;
//    without the margin a clamped row is exactly 6574 days and findViolations rejects it), >= founding, <= today
rows = rows.map((r) => {
  const floor = Math.max(new Date(r.birthDate).getTime() + (18 * 365.25 + 1) * 864e5, FOUNDED);
  const iso = new Date(Math.max(new Date(r.hireDate).getTime(), floor)).toISOString().slice(0, 10);
  return { ...r, hireDate: iso > today ? today : iso };
});

// 3) calibrate to exact target ratios (deterministic: reassign surplus rows to deficit categories)
function calibrate(field: "employeeType" | "status", target: Record<string, number>): void {
  const want = Object.fromEntries(Object.entries(target).map(([v, p]) => [v, Math.round(p * N)]));
  const have: Record<string, number> = {}; for (const r of rows) have[r[field]] = (have[r[field]] ?? 0) + 1;
  const under = Object.keys(want).filter((v) => (have[v] ?? 0) < want[v]);
  for (const r of rows) {
    if (!under.length) break;
    const cur = r[field];
    if ((have[cur] ?? 0) > want[cur]) {
      const to = under[0]; Object.assign(r, { [field]: to }); have[cur]--; have[to] = (have[to] ?? 0) + 1;
      if ((have[to] ?? 0) >= want[to]) under.shift();
    }
  }
}
calibrate("employeeType", RATIOS.employeeType);
calibrate("status", RATIOS.status);

// 3b) guarantee >=1 account-transition row for the UC4 demo (Rockfish asserts this; the fallback forces it)
if (!rows.some((r) => r.priorCostCenter)) {
  const r = rows.find((x) => x.status === "A") ?? rows[0];
  r.priorCostCenter = CENTERS.find((c) => c !== r.costCenter)!;
}

// 4) gate: refuse to write invalid data
const violations = findViolations(rows);
if (violations.length) { console.error(violations); throw new Error(`generated data invalid: ${violations.length} violations`); }

// 5) write once
const out = fileURLToPath(new URL("../fixtures/employees.json", import.meta.url));
writeFileSync(out, JSON.stringify(rows, null, 2) + "\n");
console.log(`wrote ${rows.length} employees -> ${out}`);
