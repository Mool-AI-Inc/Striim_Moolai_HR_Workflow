/**
 * UC4 module manifest — plug-ready UseCaseModule for the monthly finance report.
 * @lifespan PRODUCTION
 * @responsibility Export the workflow + the module-owned writeFinanceReport activity + a monthly `schedule`
 *   trigger; Plan 1 wires this into registry.ts/workflows.bundle.ts (not touched here).
 */
import type { UseCaseModule } from "../../platform/usecase.js";
import type { FinanceReportRow } from "../../platform/domain/types.js";
import { monthlyFinanceReport } from "./workflow.js";
import { writeFinanceReport } from "./activities.js";

const COMPANY_ID = process.env.COMPANY_ID ?? "C1";

export const monthlyFinanceReportModule: UseCaseModule = {
  name: "monthlyFinanceReport",
  workflows: { monthlyFinanceReport },
  // wrapped to fit the manifest's erased `(...a: unknown[]) => Promise<unknown>` activity shape —
  // writeFinanceReport itself stays typed against FinanceReportRow[] for every real caller.
  activities: { writeFinanceReport: (name: unknown, rows: unknown) => writeFinanceReport(name as string, rows as FinanceReportRow[]) },
  triggers: [
    {
      kind: "schedule",
      id: "monthlyFinanceReport",
      cron: "0 9 1 * *",
      start: async (host) => {
        const monthISO = new Date().toISOString().slice(0, 7);
        await host.temporal.workflow.start(monthlyFinanceReport, {
          taskQueue: "main",
          workflowId: `monthlyFinanceReport:${monthISO}`,
          args: [{ companyId: COMPANY_ID, monthISO }],
        });
      },
    },
  ],
};
