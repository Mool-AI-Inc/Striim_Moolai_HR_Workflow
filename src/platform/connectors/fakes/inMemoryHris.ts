/**
 * In-memory HRIS fake — Layer-B scaffolding that module workflow tests inject.
 * @lifespan THROWAWAY — lives under src/ but is never imported by a prod entrypoint; a test double only.
 * @responsibility Serve seeded EmployeeRecords by id; throw on an unknown id.
 */
import type { HrisReadConnector } from "../types.js";
import type { EmployeeRecord } from "../../domain/types.js";

export class InMemoryHris implements HrisReadConnector {
  private readonly byId: Map<string, EmployeeRecord>;
  constructor(employees: EmployeeRecord[]) {
    this.byId = new Map(employees.map((e) => [e.employeeId, e]));
  }
  async getEmployee(_companyId: string, employeeId: string): Promise<EmployeeRecord> {
    const e = this.byId.get(employeeId);
    if (!e) throw new Error(`unknown employee ${employeeId}`);
    return e;
  }
  async listEmployees(_companyId: string): Promise<EmployeeRecord[]> {
    return [...this.byId.values()];
  }
}
