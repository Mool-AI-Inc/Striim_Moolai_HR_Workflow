/**
 * UC4 monthlyFinanceReport workflow tests (time-skipping) — transition flagging, release-ack approval.
 * @lifespan THROWAWAY — temporal-tier test only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import type { WorkflowHandle } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import { InMemoryHris } from "../../src/platform/connectors/fakes/inMemoryHris.js";
import { InMemoryComms } from "../../src/platform/connectors/fakes/inMemoryComms.js";
import { InMemoryReportSink } from "../../src/usecases/monthlyFinanceReport/fakes/inMemoryReportSink.js";
import { decideUpdate, pendingQuery } from "../../src/platform/approvals.js";
import { registerPending, resolvePending } from "../../src/platform/activities.js";
import { getApproval } from "../../src/platform/db/approvals.js";
import { migrate } from "../../src/platform/db/sendLedger.js";
import { closePool } from "../../src/platform/db/pool.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";
import { TEMPLATE } from "../../src/platform/domain/types.js";
import type { EmployeeRecord, TransactionalEmail, FinanceReportRow } from "../../src/platform/domain/types.js";
import type { DriveConnector } from "../../src/platform/connectors/types.js";
import { monthlyFinanceReport } from "../../src/usecases/monthlyFinanceReport/workflow.js";

// @ts-expect-error — DriveConnector intentionally has NO setPermissions (spec §8: automation never changes
// sharing/permissions). UC4 report release (granting Finance access) stays a human action outside the
// system — this workflow never has a permission-granting call available to make, by construction.
type _NoPerms = Parameters<DriveConnector["setPermissions"]>;

const TASK_QUEUE = "uc4-report-test";
const MONTH = "2026-08";

/**
 * Poll until the workflow has run its preceding activities and parked on awaitApproval (handler registered).
 * The `pending` query handler doesn't exist until awaitApproval runs, so an early query is rejected outright
 * (not buffered) — retry through that instead of treating it as fatal.
 */
async function waitUntilPending(handle: WorkflowHandle): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if (await handle.query(pendingQuery)) return;
    } catch {
      // handler not registered yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for the finance-report approval to become pending");
}

const TRANSITIONED = makeEmployee({ employeeId: "E-T1", email: "t1@instantteams.test", hireDate: "2026-08-05", costCenter: "CC-ENG", priorCostCenter: "CC-OPS" });
const NOT_TRANSITIONED = makeEmployee({ employeeId: "E-T2", email: "t2@instantteams.test", hireDate: "2026-08-12", costCenter: "CC-RETAIL" });
const OTHER_MONTH = makeEmployee({ employeeId: "E-OTHER", email: "other@instantteams.test", hireDate: "2026-07-01" });

describe("UC4 monthlyFinanceReport workflow", () => {
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let runPromise: Promise<void>;
  let comms: InMemoryComms;
  let sink: InMemoryReportSink;

  beforeAll(async () => {
    await migrate();
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const hris = new InMemoryHris([TRANSITIONED, NOT_TRANSITIONED, OTHER_MONTH]);
    comms = new InMemoryComms();
    sink = new InMemoryReportSink();
    worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("../../src/usecases/monthlyFinanceReport/workflow.ts", import.meta.url)),
      activities: {
        listEmployees: (companyId: string): Promise<EmployeeRecord[]> => hris.listEmployees(companyId),
        sendEmail: async (email: TransactionalEmail): Promise<{ messageId: string }> => {
          const receipt = await comms.sendTransactional(email);
          return { messageId: receipt.messageId };
        },
        writeFinanceReport: (name: string, rows: FinanceReportRow[]) => sink.write(name, rows, (r) => r.isTransition),
        registerPending,
        resolvePending,
      },
    });
    runPromise = worker.run();
  });

  afterAll(async () => {
    worker.shutdown();
    await runPromise.catch(() => {});
    await env.teardown();
    await closePool();
  });

  it("writes only this month's hires with the transition row highlighted, notifies Taylor, and files a pending finance-report approval; approving records the release-acknowledgment audit", async () => {
    const handle = await env.client.workflow.start(monthlyFinanceReport, {
      taskQueue: TASK_QUEUE,
      workflowId: "uc4-report-approve",
      args: [{ companyId: "C1", monthISO: MONTH }],
    });

    await waitUntilPending(handle);
    await handle.executeUpdate(decideUpdate, { args: [{ approved: true, reason: "reviewed, releasing to Finance", approver: "taylor" }] });
    await handle.result();

    expect(sink.writes).toHaveLength(1);
    const write = sink.writes[0]!;
    expect(write.rows.map((r) => r.employeeId).sort()).toEqual(["E-T1", "E-T2"]); // OTHER_MONTH excluded
    expect(write.highlighted.map((r) => r.employeeId)).toEqual(["E-T1"]); // only the transition

    expect(comms.sent).toHaveLength(1);
    expect(comms.sent[0]).toMatchObject({
      to: "taylor@instantteams.test",
      templateAlias: TEMPLATE.UC4_REPORT_READY,
      idempotencyKey: `uc4-report-ready:${MONTH}`,
    });

    const approval = await getApproval("uc4-report-approve");
    expect(approval).toMatchObject({ kind: "finance-report", status: "approved" });
  });

  it("expires (no auto-release) if nobody decides within the 14-day window — still an audit-only record", async () => {
    const result = await env.client.workflow.execute(monthlyFinanceReport, {
      taskQueue: TASK_QUEUE,
      workflowId: "uc4-report-expire",
      args: [{ companyId: "C1", monthISO: MONTH }],
    });
    expect(result).toBeUndefined();

    const approval = await getApproval("uc4-report-expire");
    expect(approval).toMatchObject({ kind: "finance-report", status: "expired" });
  });
});
