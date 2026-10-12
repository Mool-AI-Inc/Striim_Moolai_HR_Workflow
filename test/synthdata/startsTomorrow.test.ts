/**
 * UC8 whoStartsTomorrow selector unit tests.
 * @lifespan THROWAWAY — unit-tier test only.
 */
import { describe, it, expect } from "vitest";
import { whoStartsTomorrow } from "../../src/usecases/startingSoonScan/selectors.js";
import { employeeStartingOn, makeEmployee } from "../../src/synthdata/scenarios.js";

describe("UC8 selector", () => {
  it("matches only the employee whose hireDate is tomorrow", () => {
    const hits = whoStartsTomorrow("2026-08-18", [employeeStartingOn("2026-08-19"), makeEmployee({ hireDate: "2020-01-01" })]);
    expect(hits.map((h) => h.employeeId)).toEqual([employeeStartingOn("2026-08-19").employeeId]);
  });

  it("does not match a hire starting today or in two days", () => {
    const hits = whoStartsTomorrow("2026-08-18", [employeeStartingOn("2026-08-18"), employeeStartingOn("2026-08-20")]);
    expect(hits).toHaveLength(0);
  });

  it("rolls over a month boundary correctly", () => {
    expect(whoStartsTomorrow("2026-02-28", [employeeStartingOn("2026-03-01")])).toHaveLength(1); // 2026 is not a leap year
  });

  it("rolls over a year boundary correctly", () => {
    expect(whoStartsTomorrow("2026-12-31", [employeeStartingOn("2027-01-01")])).toHaveLength(1);
  });

  it("skips inactive (non-'A') employees even if the date matches", () => {
    expect(whoStartsTomorrow("2026-08-18", [makeEmployee({ hireDate: "2026-08-19", status: "T" })])).toHaveLength(0);
  });
});
