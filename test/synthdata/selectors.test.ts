/**
 * UC5 whoCelebratesOn selector unit tests — leap-year rule, hire-year exclusion.
 * @lifespan THROWAWAY — unit-tier test only.
 */
import { describe, it, expect } from "vitest";
import { whoCelebratesOn } from "../../src/usecases/birthdayAnniversaryScan/selectors.js";
import { employeeWithBirthdayOn, employeeWithAnniversaryOn, makeEmployee } from "../../src/synthdata/scenarios.js";
describe("UC5 selector", () => {
  it("matches month+day for birthdays and anniversaries, ignores others", () => {
    const hits = whoCelebratesOn("2026-03-14", [employeeWithBirthdayOn("2026-03-14"), employeeWithAnniversaryOn("2026-03-14"), makeEmployee({ birthDate: "1990-12-01", hireDate: "2020-06-01" })]);
    expect(hits.map((h) => h.occasion).sort()).toEqual(["anniversary", "birthday"]);
  });
  it("does not fire an anniversary in the hire year itself", () => {
    expect(whoCelebratesOn("2026-03-14", [makeEmployee({ hireDate: "2026-03-14" })]).some((h) => h.occasion === "anniversary")).toBe(false);
  });
  it("fires a Feb-29 birthday on Feb-28 in a non-leap year", () => {
    expect(whoCelebratesOn("2027-02-28", [makeEmployee({ birthDate: "1996-02-29" })]).some((h) => h.occasion === "birthday")).toBe(true);
  });
  it("fires a Feb-29 HIRE anniversary on Feb-28 in a non-leap year", () => {
    expect(whoCelebratesOn("2027-02-28", [makeEmployee({ hireDate: "2020-02-29" })]).some((h) => h.occasion === "anniversary")).toBe(true);
  });
  it("skips inactive (non-'A') employees", () => {
    expect(whoCelebratesOn("2026-03-14", [makeEmployee({ birthDate: "1990-03-14", status: "T" })])).toHaveLength(0);
  });
});
