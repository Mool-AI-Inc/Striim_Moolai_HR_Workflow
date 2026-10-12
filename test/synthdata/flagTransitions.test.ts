/**
 * UC4 flagTransitions selector unit tests.
 * @lifespan THROWAWAY — unit-tier test only.
 */
import { describe, it, expect } from "vitest";
import { flagTransitions } from "../../src/usecases/monthlyFinanceReport/selectors.js";
import type { UnflaggedRow } from "../../src/usecases/monthlyFinanceReport/selectors.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";

const rowFor = (o: Parameters<typeof makeEmployee>[0] = {}): UnflaggedRow => {
  const e = makeEmployee(o);
  return { employeeId: e.employeeId, name: `${e.firstName} ${e.lastName}`, costCenter: e.costCenter, priorCostCenter: e.priorCostCenter, hireDate: e.hireDate };
};

describe("UC4 flagTransitions", () => {
  it("flags a row whose priorCostCenter is present and differs from costCenter", () => {
    const [row] = flagTransitions([rowFor({ employeeId: "E-T1", costCenter: "CC-ENG", priorCostCenter: "CC-OPS" })]);
    expect(row!.isTransition).toBe(true);
  });

  it("does not flag a row with no priorCostCenter", () => {
    const [row] = flagTransitions([rowFor({ employeeId: "E-NEW" })]);
    expect(row!.isTransition).toBe(false);
  });

  it("does not flag a row whose priorCostCenter equals costCenter", () => {
    const [row] = flagTransitions([rowFor({ employeeId: "E-SAME", costCenter: "CC-OPS", priorCostCenter: "CC-OPS" })]);
    expect(row!.isTransition).toBe(false);
  });

  it("flags only the transitioning rows in a mixed batch, leaving other fields untouched", () => {
    const rows = flagTransitions([
      rowFor({ employeeId: "E-T1", costCenter: "CC-ENG", priorCostCenter: "CC-OPS" }),
      rowFor({ employeeId: "E-T2", costCenter: "CC-RETAIL" }),
    ]);
    expect(rows.map((r) => [r.employeeId, r.isTransition])).toEqual([
      ["E-T1", true],
      ["E-T2", false],
    ]);
    expect(rows[0]).toMatchObject({ employeeId: "E-T1", costCenter: "CC-ENG", priorCostCenter: "CC-OPS" });
  });
});
