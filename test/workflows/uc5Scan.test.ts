/**
 * UC5 birthdayAnniversaryScan workflow tests (time-skipping).
 * @lifespan THROWAWAY — temporal-tier test only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { InMemoryHris } from "../../src/platform/connectors/fakes/inMemoryHris.js";
import { InMemoryComms } from "../../src/platform/connectors/fakes/inMemoryComms.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";
import { TEMPLATE } from "../../src/platform/domain/types.js";
import type { EmployeeRecord, TransactionalEmail } from "../../src/platform/domain/types.js";
import { birthdayAnniversaryScan } from "../../src/usecases/birthdayAnniversaryScan/workflow.js";

const TASK_QUEUE = "uc5-scan-test";
const TODAY = "2026-03-14";

describe("UC5 birthdayAnniversaryScan workflow", () => {
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let runPromise: Promise<void>;
  let comms: InMemoryComms;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const hris = new InMemoryHris([
      makeEmployee({ employeeId: "BD-1", birthDate: "1990-03-14", hireDate: "2015-01-01" }),         // birthday today
      makeEmployee({ employeeId: "AN-1", birthDate: "1985-05-05", hireDate: "2020-03-14" }),          // anniversary today
      makeEmployee({ employeeId: "HIRE-YEAR", birthDate: "1985-05-05", hireDate: "2026-03-14" }),     // hired today this year — no anniversary yet
      makeEmployee({ employeeId: "NOPE", birthDate: "1990-12-01", hireDate: "2018-06-01" }),          // no match
      makeEmployee({ employeeId: "TERM", birthDate: "1990-03-14", hireDate: "2015-01-01", status: "T" }), // inactive — skipped
    ]);
    comms = new InMemoryComms();
    worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("../../src/usecases/birthdayAnniversaryScan/workflow.ts", import.meta.url)),
      activities: {
        listEmployees: (companyId: string): Promise<EmployeeRecord[]> => hris.listEmployees(companyId),
        sendEmail: async (email: TransactionalEmail): Promise<{ messageId: string }> => {
          const receipt = await comms.sendTransactional(email);
          return { messageId: receipt.messageId };
        },
      },
    });
    runPromise = worker.run();
  });

  afterAll(async () => {
    worker.shutdown();
    await runPromise.catch(() => {});
    await env.teardown();
  });

  it("sends exactly the BIRTHDAY + ANNIVERSARY emails for today's active celebrants, keyed with the year", async () => {
    await env.client.workflow.execute(birthdayAnniversaryScan, {
      taskQueue: TASK_QUEUE,
      workflowId: "uc5-scan-1",
      args: [{ companyId: "C1", todayISO: TODAY }],
    });

    expect(comms.sent).toHaveLength(2);
    const byTemplate = Object.fromEntries(comms.sent.map((m) => [m.templateAlias, m]));

    expect(byTemplate[TEMPLATE.BIRTHDAY]).toMatchObject({
      to: "test.person@instantteams.test",
      idempotencyKey: "birthday:BD-1:2026",
    });
    expect(byTemplate[TEMPLATE.ANNIVERSARY]).toMatchObject({
      to: "test.person@instantteams.test",
      idempotencyKey: "anniversary:AN-1:2026",
    });
  });
});
