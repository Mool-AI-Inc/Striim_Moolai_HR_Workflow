import { describe, it, expect } from "vitest";
import { loadDemoEmployees, findViolations, employeeWithBirthdayOn, employeeStartingOn, makeEmployee } from "../../src/synthdata/scenarios.js";
describe("demo fixture (Layer D)", () => {
  it("the committed fixture is present, sizable, and valid", () => {
    const rows = loadDemoEmployees();
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(findViolations(rows)).toEqual([]);
  });
  it("reflects a realistic full-time majority", () => {
    const rows = loadDemoEmployees();
    expect(rows.filter((r) => r.employeeType === "RFT").length / rows.length).toBeGreaterThan(0.6);
  });
  it("catches a hand-broken row (hire before 18th birthday)", () => {
    expect(findViolations([makeEmployee({ birthDate: "2020-01-01", hireDate: "2021-01-01" })]).length).toBeGreaterThan(0);
  });
  it("scenario builders fix month/day and start date", () => {
    expect(employeeWithBirthdayOn("1995-03-14").birthDate.endsWith("-03-14")).toBe(true);
    expect(employeeStartingOn("2026-08-19").hireDate).toBe("2026-08-19");
  });
});
