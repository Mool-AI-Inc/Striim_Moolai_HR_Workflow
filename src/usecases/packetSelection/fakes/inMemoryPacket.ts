/**
 * In-memory packet fake — records assignments for workflow tests.
 * @lifespan THROWAWAY — a test double only.
 */
import type { PacketConnector } from "../../../platform/connectors/types.js";

export class InMemoryPacket implements PacketConnector {
  readonly assignments: { employeeId: string; packetId: string }[] = [];
  async assignPacket(employeeId: string, packetId: string): Promise<{ receiptId: string }> {
    this.assignments.push({ employeeId, packetId }); return { receiptId: `asg-${this.assignments.length}` };
  }
}
