/**
 * newHireLifecycle module manifest.
 * @lifespan PRODUCTION — the plug-in registration the host reads; imports only platform/* + this folder.
 */
import type { UseCaseModule } from "../../platform/usecase.js";
import { recordOptOut } from "../../platform/db/sendLedger.js";
import { newHireLifecycle } from "./workflow.js";
import { sendSms } from "./activities.js";

export const module: UseCaseModule = {
  name: "newHireLifecycle",
  workflows: { newHireLifecycle },
  activities: { sendSms } as UseCaseModule["activities"],
  triggers: [
    { kind: "event", event: "employee.new-hire",
      start: (p, host) => host.temporal.workflow.start(newHireLifecycle, {
        taskQueue: "main", workflowId: `newhire:${p.employeeId}`,
        args: [{ companyId: p.companyId, employeeId: p.employeeId }], workflowIdReusePolicy: "REJECT_DUPLICATE",
      }).then(() => {}) },
    { kind: "webhook", method: "POST", path: "/webhooks/sms/stop",
      handler: async (body) => { await recordOptOut((body as { phone: string }).phone); } },
  ],
};
