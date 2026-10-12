/**
 * UC3 personnelFile workflow tests (time-skipping) — gather/file, checklist, approve-gated finalize, reject.
 * @lifespan THROWAWAY — temporal-tier test only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import type { WorkflowHandle } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import { InMemoryHris } from "../../src/platform/connectors/fakes/inMemoryHris.js";
import { InMemoryDocs } from "../../src/usecases/personnelFile/fakes/inMemoryDocs.js";
import { InMemoryDrive } from "../../src/usecases/personnelFile/fakes/inMemoryDrive.js";
import { decideUpdate, pendingQuery } from "../../src/platform/approvals.js";
import { registerPending, resolvePending, alarmDidNotSend } from "../../src/platform/activities.js";
import { getApproval } from "../../src/platform/db/approvals.js";
import { migrate } from "../../src/platform/db/sendLedger.js";
import { getPool, closePool } from "../../src/platform/db/pool.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";
import type { EmployeeRecord, ScreeningDoc, PersonnelChecklist } from "../../src/platform/domain/types.js";
import { personnelFile } from "../../src/usecases/personnelFile/workflow.js";

const TASK_QUEUE = "uc3-personnel-file-test";

const BACKGROUND_CHECK: ScreeningDoc = { filename: "background-check-SCR1.pdf", contentType: "application/pdf", bytes: new Uint8Array([1, 2, 3]) };
const I9: ScreeningDoc = { filename: "i9-SUB1.pdf", contentType: "application/pdf", bytes: new Uint8Array([4, 5, 6]) };

/** Poll until the workflow has run its preceding activities and parked on awaitApproval (handler registered). */
async function waitUntilPending(handle: WorkflowHandle): Promise<PersonnelChecklist> {
  for (let i = 0; i < 100; i++) {
    try {
      const pending = await handle.query(pendingQuery);
      if (pending) return pending.detail as PersonnelChecklist;
    } catch {
      // handler not registered yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for the personnel-file approval to become pending");
}

describe("UC3 personnelFile workflow", () => {
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let runPromise: Promise<void>;
  let hris: InMemoryHris;
  let docs: InMemoryDocs;
  let drive: InMemoryDrive;
  let stagingCalls: Array<{ companyId: string; employee: EmployeeRecord }>;
  let stagingFailFor: Set<string>;

  const EMPLOYEES = [
    makeEmployee({ employeeId: "E-PF1", email: "pf1@instantteams.test" }),
    makeEmployee({ employeeId: "E-PF2", email: "pf2@instantteams.test" }),
    makeEmployee({ employeeId: "E-PF3", email: "pf3@instantteams.test" }),
    makeEmployee({ employeeId: "E-PF4", email: "pf4@instantteams.test" }),
  ];

  beforeAll(async () => {
    await migrate();
    env = await TestWorkflowEnvironment.createTimeSkipping();
    hris = new InMemoryHris(EMPLOYEES);
    docs = new InMemoryDocs({ SCR1: BACKGROUND_CHECK, SUB1: I9 });
    drive = new InMemoryDrive();
    stagingCalls = [];
    stagingFailFor = new Set();
    worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("../../src/usecases/personnelFile/workflow.ts", import.meta.url)),
      activities: {
        getEmployee: (companyId: string, employeeId: string) => hris.getEmployee(companyId, employeeId),
        fetchBackgroundCheck: (screeningId: string) => docs.getScreening(screeningId),
        fetchI9: (submissionId: string) => docs.getSubmissionFile(submissionId),
        fileDocument: (folderId: string, doc: ScreeningDoc) => drive.putFile(folderId, doc.filename, doc.bytes, doc.contentType),
        createEmployeeStaging: async (companyId: string, employee: EmployeeRecord) => {
          // Mimics the real ledgered createEmployeeStaging's failure path (recordSend 'failed' + rethrow) so
          // the workflow's bounded retry (maximumAttempts: 3) actually exhausts and the alarm fires — a real
          // unbounded-retry activity would hang this test instead.
          if (stagingFailFor.has(employee.employeeId)) throw new Error("forced Paylocity staging failure");
          stagingCalls.push({ companyId, employee });
          return { employeeId: employee.employeeId };
        },
        alarmDidNotSend,
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

  it("both docs arrive → both are filed, the checklist is complete, and approval finalizes the Paylocity staging exactly once", async () => {
    const handle = await env.client.workflow.start(personnelFile, {
      taskQueue: TASK_QUEUE,
      workflowId: "personnel:E-PF1",
      args: [{ companyId: "C1", employeeId: "E-PF1", screeningId: "SCR1", submissionId: "SUB1", folderId: "FOLDER1" }],
    });

    const checklist = await waitUntilPending(handle);
    expect(checklist).toEqual({ employeeId: "E-PF1", arrived: ["background-check", "i-9"], missing: [] });
    expect(drive.files.map((f) => f.name).sort()).toEqual(["background-check-SCR1.pdf", "i9-SUB1.pdf"]);

    await handle.executeUpdate(decideUpdate, { args: [{ approved: true, reason: "checklist complete", approver: "hr-admin" }] });
    await handle.result();

    expect(stagingCalls).toHaveLength(1);
    expect(stagingCalls[0]).toMatchObject({ companyId: "C1", employee: { employeeId: "E-PF1" } });

    const approval = await getApproval("personnel:E-PF1");
    expect(approval).toMatchObject({ kind: "personnel-file", status: "approved" });
  });

  it("a missing I-9 is never filed, the checklist reports it missing, and finalize stays gated until a decision arrives", async () => {
    const handle = await env.client.workflow.start(personnelFile, {
      taskQueue: TASK_QUEUE,
      workflowId: "personnel:E-PF2",
      args: [{ companyId: "C1", employeeId: "E-PF2", screeningId: "SCR1", folderId: "FOLDER2" }], // no submissionId
    });

    const checklist = await waitUntilPending(handle);
    expect(checklist).toEqual({ employeeId: "E-PF2", arrived: ["background-check"], missing: ["i-9"] });
    expect(drive.files.filter((f) => f.folderId === "FOLDER2").map((f) => f.name)).toEqual(["background-check-SCR1.pdf"]);
    expect(stagingCalls.filter((c) => c.employee.employeeId === "E-PF2")).toHaveLength(0); // gated pre-decision

    await handle.executeUpdate(decideUpdate, { args: [{ approved: true, reason: "proceeding despite missing I-9", approver: "hr-admin" }] });
    await handle.result();

    expect(stagingCalls.filter((c) => c.employee.employeeId === "E-PF2")).toHaveLength(1);
  });

  it("a rejection never finalizes staging and fires the did-not-send alarm", async () => {
    const handle = await env.client.workflow.start(personnelFile, {
      taskQueue: TASK_QUEUE,
      workflowId: "personnel:E-PF3",
      args: [{ companyId: "C1", employeeId: "E-PF3", screeningId: "SCR1", submissionId: "SUB1", folderId: "FOLDER3" }],
    });

    await waitUntilPending(handle);
    await handle.executeUpdate(decideUpdate, { args: [{ approved: false, reason: "background check flagged", approver: "hr-admin" }] });
    await handle.result();

    expect(stagingCalls.filter((c) => c.employee.employeeId === "E-PF3")).toHaveLength(0);

    const approval = await getApproval("personnel:E-PF3");
    expect(approval).toMatchObject({ kind: "personnel-file", status: "rejected" });

    const r = await getPool().query(`SELECT count(*)::int AS n FROM send_ledger WHERE status='alarm' AND template='personnel-file' AND "to"='E-PF3'`);
    expect(r.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("alarms when createEmployeeStaging fails after approval, instead of retrying forever", async () => {
    stagingFailFor.add("E-PF4");
    const handle = await env.client.workflow.start(personnelFile, {
      taskQueue: TASK_QUEUE,
      workflowId: "personnel:E-PF4",
      args: [{ companyId: "C1", employeeId: "E-PF4", screeningId: "SCR1", submissionId: "SUB1", folderId: "FOLDER4" }],
    });

    await waitUntilPending(handle);
    await handle.executeUpdate(decideUpdate, { args: [{ approved: true, reason: "checklist complete", approver: "hr-admin" }] });
    await handle.result(); // resolves at all only because createEmployeeStaging has a bounded retry (maximumAttempts: 3)

    expect(stagingCalls.filter((c) => c.employee.employeeId === "E-PF4")).toHaveLength(0);

    // The approval itself is still recorded "approved" — the human's decision stands; it's the Paylocity
    // staging call that failed, which is why this needs its own alarm.
    const approval = await getApproval("personnel:E-PF4");
    expect(approval).toMatchObject({ kind: "personnel-file", status: "approved" });

    const r = await getPool().query(`SELECT count(*)::int AS n FROM send_ledger WHERE status='alarm' AND template='personnel-file' AND "to"='E-PF4'`);
    expect(r.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});
