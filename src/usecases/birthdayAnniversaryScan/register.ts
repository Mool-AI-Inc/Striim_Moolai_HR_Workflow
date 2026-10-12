/**
 * UC5 module manifest — plug-ready UseCaseModule for the daily birthday/anniversary scan.
 * @lifespan PRODUCTION
 * @responsibility Export the workflow + a daily `schedule` trigger; Plan 1 wires this into
 *   registry.ts/workflows.bundle.ts (not touched here).
 */
import type { UseCaseModule } from "../../platform/usecase.js";
import { birthdayAnniversaryScan } from "./workflow.js";

const COMPANY_ID = process.env.COMPANY_ID ?? "C1";

export const birthdayAnniversaryScanModule: UseCaseModule = {
  name: "birthdayAnniversaryScan",
  workflows: { birthdayAnniversaryScan },
  activities: {},
  triggers: [
    {
      kind: "schedule",
      id: "birthdayAnniversaryScan",
      cron: "0 9 * * *",
      start: async (host) => {
        const todayISO = new Date().toISOString().slice(0, 10);
        await host.temporal.workflow.start(birthdayAnniversaryScan, {
          taskQueue: "main",
          workflowId: `birthdayAnniversaryScan:${todayISO}`,
          args: [{ companyId: COMPANY_ID, todayISO }],
        });
      },
    },
  ],
};
