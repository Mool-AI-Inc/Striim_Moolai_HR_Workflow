/**
 * UC8 module manifest — plug-ready UseCaseModule for the daily "starts tomorrow" Slack invite scan.
 * @lifespan PRODUCTION
 * @responsibility Export the workflow + the module-owned inviteToSlack activity + a daily `schedule` trigger;
 *   Plan 1 wires this into registry.ts/workflows.bundle.ts (not touched here).
 */
import type { UseCaseModule } from "../../platform/usecase.js";
import type { EmployeeRecord } from "../../platform/domain/types.js";
import { startingSoonScan } from "./workflow.js";
import { inviteToSlack } from "./activities.js";

const COMPANY_ID = process.env.COMPANY_ID ?? "C1";

export const startingSoonScanModule: UseCaseModule = {
  name: "startingSoonScan",
  workflows: { startingSoonScan },
  // wrapped to fit the manifest's erased `(...a: unknown[]) => Promise<unknown>` activity shape —
  // inviteToSlack itself stays typed against EmployeeRecord for every real caller (workflow.ts, tests).
  activities: { inviteToSlack: (employee: unknown) => inviteToSlack(employee as EmployeeRecord) },
  triggers: [
    {
      kind: "schedule",
      id: "startingSoonScan",
      cron: "0 9 * * *",
      start: async (host) => {
        const todayISO = new Date().toISOString().slice(0, 10);
        await host.temporal.workflow.start(startingSoonScan, {
          taskQueue: "main",
          workflowId: `startingSoonScan:${todayISO}`,
          args: [{ companyId: COMPANY_ID, todayISO }],
        });
      },
    },
  ],
};
