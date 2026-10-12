/**
 * In-memory EN fake — records sends for workflow tests.
 * @lifespan THROWAWAY — a test double only.
 */
import type { EmployeeNavigatorConnector } from "../../../platform/connectors/types.js";

export class InMemoryEn implements EmployeeNavigatorConnector {
  readonly sends: string[] = [];
  async stageSend(employeeId: string): Promise<{ receiptId: string }> { this.sends.push(employeeId); return { receiptId: `en-${this.sends.length}` }; }
}
