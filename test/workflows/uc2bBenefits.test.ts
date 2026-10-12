import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { benefitsDay60Send } from "../../src/usecases/benefitsDay60Send/workflow.js";
import { newHireLifecycle } from "../../src/usecases/newHireLifecycle/workflow.js";
import { decideUpdate } from "../../src/platform/approvals.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";
import { InMemoryHris } from "../../src/platform/connectors/fakes/inMemoryHris.js";

const TASK_QUEUE = "test";
const today = () => new Date().toISOString().slice(0, 10);
const hris = new InMemoryHris([makeEmployee({ employeeId: "PARENT1", smsConsent: false, hireDate: today() })]);
const sends: string[] = [];
const alarms: { employeeId: string; template: string; reason: string }[] = [];
let onPendingRegistered: (() => void) | null = null;
const activities = {
  getEmployee: (c: string, e: string) => hris.getEmployee(c, e),
  sendEmail: async () => ({ messageId: "ok" }),
  sendSms: async () => ({ messageId: "sms" }),
  stageSend: async (_c: string, e: string) => { sends.push(e); return { receiptId: `en-${sends.length}` }; },
  alarmDidNotSend: async (a: { employeeId: string; template: string; reason: string }) => { alarms.push(a); },
  registerPending: async () => { onPendingRegistered?.(); },
  resolvePending: async () => {},
};

describe("benefitsDay60Send (UC2b) + parent hand-off", () => {
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let runPromise: Promise<void>;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    worker = await Worker.create({
      connection: env.nativeConnection, taskQueue: TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("./fixtures/newHireArcBundle.ts", import.meta.url)),   // parent + child
      activities,
    });
    runPromise = worker.run();
  });
  afterAll(async () => {
    worker.shutdown();
    await runPromise.catch(() => {});
    await env.teardown();
  });

  it("approve → stages the EN send", async () => {
    sends.length = 0; alarms.length = 0;
    const registered = new Promise<void>((res) => { onPendingRegistered = res; });
    const handle = await env.client.workflow.start(benefitsDay60Send, {
      taskQueue: TASK_QUEUE, workflowId: "wf-ben-approve", args: [{ companyId: "C1", employeeId: "B1" }],
    });
    await registered;
    await handle.executeUpdate(decideUpdate, { args: [{ approved: true, reason: "ok", approver: "reviewer@instantteams.test" }] });
    await handle.result();
    expect(sends).toEqual(["B1"]);
    expect(alarms).toHaveLength(0);
  });

  it("reject → no send, fires a did-not-send alarm", async () => {
    sends.length = 0; alarms.length = 0;
    const registered = new Promise<void>((res) => { onPendingRegistered = res; });
    const handle = await env.client.workflow.start(benefitsDay60Send, {
      taskQueue: TASK_QUEUE, workflowId: "wf-ben-reject", args: [{ companyId: "C1", employeeId: "B2" }],
    });
    await registered;
    await handle.executeUpdate(decideUpdate, { args: [{ approved: false, reason: "not yet", approver: "reviewer@instantteams.test" }] });
    await handle.result();
    expect(sends).toHaveLength(0);
    expect(alarms.map((a) => a.template)).toEqual(["benefits-send"]);
  });

  it("newHireLifecycle starts benefitsDay60Send as a detached child", async () => {
    sends.length = 0; alarms.length = 0;
    await env.client.workflow.execute(newHireLifecycle, {
      taskQueue: TASK_QUEUE, workflowId: "wf-parent1", args: [{ companyId: "C1", employeeId: "PARENT1" }],
    });
    const child = env.client.workflow.getHandle("benefits60:PARENT1");
    const desc = await child.describe();
    expect(["RUNNING", "COMPLETED"]).toContain(desc.status.name);
  });
});
