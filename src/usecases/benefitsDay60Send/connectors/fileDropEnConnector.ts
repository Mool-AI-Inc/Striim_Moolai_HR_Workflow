/**
 * File-drop Employee Navigator connector — the RPA-robot stand-in for the UC2b Day-60 send.
 * @lifespan THROWAWAY — drops a send receipt via the simulator in both modes until the Playwright runner exists.
 * @responsibility POST the send to the simulator; return its receipt.
 */
import type { EmployeeNavigatorConnector } from "../../../platform/connectors/types.js";

export class FileDropEnConnector implements EmployeeNavigatorConnector {
  constructor(private readonly opts: { baseUrl: string }) {}
  async stageSend(employeeId: string): Promise<{ receiptId: string }> {
    const res = await fetch(`${this.opts.baseUrl}/en/${encodeURIComponent(employeeId)}/send`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`en send failed: ${res.status}`);
    return (await res.json()) as { receiptId: string };
  }
}
