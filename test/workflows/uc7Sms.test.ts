import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { newHireLifecycle } from "../../src/usecases/newHireLifecycle/workflow.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";
import { InMemoryComms } from "../../src/platform/connectors/fakes/inMemoryComms.js";
import { InMemoryHris } from "../../src/platform/connectors/fakes/inMemoryHris.js";
import { InMemorySms } from "../../src/usecases/newHireLifecycle/fakes/inMemorySms.js";

let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); });
afterAll(async () => { await env?.teardown(); });

const today = () => new Date().toISOString().slice(0, 10);

async function run(emp: import("../../src/platform/domain/types.js").EmployeeRecord, workflowId: string) {
  const comms = new InMemoryComms();
  const sms = new InMemorySms();
  const hris = new InMemoryHris([emp]);
  const activities = {
    getEmployee: (c: string, e: string) => hris.getEmployee(c, e),
    sendEmail: (m: import("../../src/platform/domain/types.js").TransactionalEmail) => comms.sendTransactional(m),
    sendSms: (m: import("../../src/platform/domain/types.js").SmsMessage) => sms.sendSms(m),
    alarmDidNotSend: async () => {},
    registerPending: async () => {}, resolvePending: async () => {}, stageSend: async () => ({ receiptId: "en-x" }),  // the detached child parks on awaitApproval
  };
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: "test",
    workflowsPath: fileURLToPath(new URL("./fixtures/newHireArcBundle.ts", import.meta.url)),   // parent + child by name
    activities,
  });
  await worker.runUntil(env.client.workflow.execute(newHireLifecycle, {
    taskQueue: "test", workflowId, args: [{ companyId: "C1", employeeId: emp.employeeId }],
  }));
  return { comms, sms };
}

describe("newHireLifecycle UC7 SMS (consent-gated)", () => {
  it("a consenting hire gets welcome + day60 email AND one welcome-sms", async () => {
    const emp = makeEmployee({ employeeId: "E-consent", email: "c@instantteams.test", smsConsent: true, hireDate: today() });
    const { comms, sms } = await run(emp, "wf-sms-consent");
    expect(comms.sent.map((s) => s.templateAlias)).toEqual(["welcome", "day60-compliance"]);
    expect(sms.sent.map((m) => m.body)).toEqual(["welcome-sms"]);
  });

  it("a non-consenting hire gets email only, no SMS", async () => {
    const emp = makeEmployee({ employeeId: "E-noconsent", email: "n@instantteams.test", smsConsent: false, hireDate: today() });
    const { comms, sms } = await run(emp, "wf-sms-noconsent");
    expect(comms.sent.map((s) => s.templateAlias)).toEqual(["welcome", "day60-compliance"]);
    expect(sms.sent).toHaveLength(0);
  });
});
