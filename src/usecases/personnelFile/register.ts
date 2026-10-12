/**
 * UC3 module manifest — plug-ready UseCaseModule for the personnel-file gather/checklist/approve/finalize flow.
 * @lifespan PRODUCTION
 * @responsibility Export the workflow + the module-owned activities + an `employee.task-complete` event
 *   trigger that starts workflowId `personnel:${employeeId}`; Plan 1 wires this into
 *   registry.ts/workflows.bundle.ts (not touched here). Idempotent by construction — the host's ingress
 *   fans events out and swallows WorkflowExecutionAlreadyStartedError, so a duplicate event for the same
 *   employee is a no-op, not an error.
 */
import type { UseCaseModule } from "../../platform/usecase.js";
import type { EmployeeRecord, ScreeningDoc } from "../../platform/domain/types.js";
import { personnelFile } from "./workflow.js";
import { fetchBackgroundCheck, fetchI9, fileDocument, createEmployeeStaging } from "./activities.js";

export const personnelFileModule: UseCaseModule = {
  name: "personnelFile",
  workflows: { personnelFile },
  // wrapped to fit the manifest's erased `(...a: unknown[]) => Promise<unknown>` activity shape — each
  // activity itself stays typed against its real params for every real caller (workflow.ts, tests).
  activities: {
    fetchBackgroundCheck: (screeningId: unknown) => fetchBackgroundCheck(screeningId as string),
    fetchI9: (submissionId: unknown) => fetchI9(submissionId as string),
    fileDocument: (folderId: unknown, doc: unknown) => fileDocument(folderId as string, doc as ScreeningDoc),
    createEmployeeStaging: (companyId: unknown, employee: unknown) => createEmployeeStaging(companyId as string, employee as EmployeeRecord),
  },
  triggers: [
    {
      kind: "event",
      event: "employee.task-complete",
      start: async (payload, host) => {
        const employeeId = String(payload.employeeId);
        // screeningId/submissionId/folderId ride the event payload's extra fields (EventPayload's index
        // signature) — ingress's `/webhooks/task-complete` route forwards the whole body through, so a real
        // webhook carrying these fields reaches this trigger directly; absent, they're just undefined and
        // buildChecklist reports the doc missing rather than guessing/half-filing it.
        await host.temporal.workflow.start(personnelFile, {
          taskQueue: "main",
          workflowId: `personnel:${employeeId}`,
          args: [{
            companyId: String(payload.companyId),
            employeeId,
            screeningId: typeof payload.screeningId === "string" ? payload.screeningId : undefined,
            submissionId: typeof payload.submissionId === "string" ? payload.submissionId : undefined,
            folderId: String(payload.folderId),
          }],
        });
      },
    },
  ],
};
