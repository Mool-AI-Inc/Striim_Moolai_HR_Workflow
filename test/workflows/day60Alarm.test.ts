import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { newHireLifecycle } from "../../src/usecases/newHireLifecycle/workflow.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";
import { InMemoryHris } from "../../src/platform/connectors/fakes/inMemoryHris.js";

let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); });
afterAll(async () => { await env?.teardown(); });

describe("newHireLifecycle Day-60 did-not-send alarm (UC2a)", () => {
  it("alarms and completes (no throw) when the Day-60 send fails", async () => {
    const emp = makeEmployee({ employeeId: "E1", email: "e1@instantteams.test", smsConsent: false, hireDate: new Date().toISOString().slice(0, 10) });
    const hris = new InMemoryHris([emp]);
    const alarms: { employeeId: string; template: string; reason: string }[] = [];
    const activities = {
      getEmployee: (c: string, e: string) => hris.getEmployee(c, e),
      sendEmail: async (m: import("../../src/platform/domain/types.js").TransactionalEmail) => {
        if (m.templateAlias === "day60-compliance") throw new Error("postmark down");
        return { messageId: "ok" };
      },
      alarmDidNotSend: async (a: { employeeId: string; template: string; reason: string }) => { alarms.push(a); },
      registerPending: async () => {}, resolvePending: async () => {}, stageSend: async () => ({ receiptId: "en-x" }),  // the detached child parks on awaitApproval
    };
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue: "test",
      workflowsPath: fileURLToPath(new URL("./fixtures/newHireArcBundle.ts", import.meta.url)),   // parent + child by name
      activities,
    });
    await worker.runUntil(env.client.workflow.execute(newHireLifecycle, {
      taskQueue: "test", workflowId: "wf-alarm-e1", args: [{ companyId: "C1", employeeId: "E1" }],
    }));
    expect(alarms.map((a) => a.template)).toContain("day60-compliance");
  });
});
