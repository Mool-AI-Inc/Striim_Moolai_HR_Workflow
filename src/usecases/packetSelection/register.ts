/**
 * packetSelection module manifest.
 * @lifespan PRODUCTION — plug-in registration; imports only platform/* + this folder.
 */
import type { UseCaseModule } from "../../platform/usecase.js";
import { packetSelection } from "./workflow.js";
import { recommendPacket, assignPacket } from "./activities.js";

export const module: UseCaseModule = {
  name: "packetSelection",
  workflows: { packetSelection },
  activities: { recommendPacket, assignPacket } as UseCaseModule["activities"],
  triggers: [
    { kind: "event", event: "employee.new-hire",
      start: (p, host) => host.temporal.workflow.start(packetSelection, {
        taskQueue: "main", workflowId: `packet:${p.employeeId}`,
        args: [{ companyId: p.companyId, employeeId: p.employeeId }], workflowIdReusePolicy: "REJECT_DUPLICATE",
      }).then(() => {}) },
  ],
};
