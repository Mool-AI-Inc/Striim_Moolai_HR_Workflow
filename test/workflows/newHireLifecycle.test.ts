import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { newHireLifecycle } from "../../src/usecases/newHireLifecycle/workflow.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";
import { InMemoryComms } from "../../src/platform/connectors/fakes/inMemoryComms.js";
import { InMemoryHris } from "../../src/platform/connectors/fakes/inMemoryHris.js";

let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); });
afterAll(async () => { await env?.teardown(); });

describe("newHireLifecycle (UC1 + UC2a)", () => {
  it("sends welcome now and compliance ~60 days after HIRE (timer skipped instantly)", async () => {
    const comms = new InMemoryComms();
    const emp = makeEmployee({ employeeId: "E1", email: "e1@instantteams.test", smsConsent: false, hireDate: new Date().toISOString().slice(0, 10) });
    const hris = new InMemoryHris([emp]);
    const activities = {
      getEmployee: (c: string, e: string) => hris.getEmployee(c, e),
      sendEmail: (m: import("../../src/platform/domain/types.js").TransactionalEmail) => comms.sendTransactional(m),
      alarmDidNotSend: async () => {},
      registerPending: async () => {}, resolvePending: async () => {}, stageSend: async () => ({ receiptId: "en-x" }),  // the detached child parks on awaitApproval
    };
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue: "test",
      workflowsPath: fileURLToPath(new URL("./fixtures/newHireArcBundle.ts", import.meta.url)),   // parent + child by name
      activities,
    });
    await worker.runUntil(env.client.workflow.execute(newHireLifecycle, {
      taskQueue: "test", workflowId: "wf-e1", args: [{ companyId: "C1", employeeId: "E1" }],
    }));
    expect(comms.sent.map((s) => s.templateAlias)).toEqual(["welcome", "day60-compliance"]);
  });
});
