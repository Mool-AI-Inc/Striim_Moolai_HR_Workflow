/**
 * File-drop packet connector — the RPA-robot stand-in for UC6 packet assignment.
 * @lifespan THROWAWAY — drops an assignment manifest via the simulator in both modes until the Playwright runner exists.
 * @responsibility POST the assignment to the simulator; return its receipt.
 */
import type { PacketConnector } from "../../../platform/connectors/types.js";

export class FileDropPacketConnector implements PacketConnector {
  constructor(private readonly opts: { baseUrl: string }) {}
  async assignPacket(employeeId: string, packetId: string, docs: string[]): Promise<{ receiptId: string }> {
    const res = await fetch(`${this.opts.baseUrl}/packets/${encodeURIComponent(employeeId)}/assign`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ packetId, docs }),
    });
    if (!res.ok) throw new Error(`packet assign failed: ${res.status}`);
    return (await res.json()) as { receiptId: string };
  }
}
