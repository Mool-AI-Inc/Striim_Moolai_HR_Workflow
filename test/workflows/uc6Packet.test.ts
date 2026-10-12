import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { packetSelection } from "../../src/usecases/packetSelection/workflow.js";
import { decideUpdate } from "../../src/platform/approvals.js";
import { RulePacketRecommender } from "../../src/usecases/packetSelection/packetRecommender.js";
import { packetFor } from "../../src/usecases/packetSelection/decisionTable.js";
import { makeEmployee } from "../../src/synthdata/scenarios.js";
import { InMemoryHris } from "../../src/platform/connectors/fakes/inMemoryHris.js";
import type { TransactionalEmail } from "../../src/platform/domain/types.js";

const TASK_QUEUE = "test";
const hris = new InMemoryHris([
  makeEmployee({ employeeId: "E1", employeeType: "RFT", costCenter: "CC-ENG" }),
  makeEmployee({ employeeId: "E2", employeeType: "RFT", costCenter: "CC-OPS" }),
]);
const FULL_E1_DOCS = packetFor({ employeeType: "RFT", costCenter: "CC-ENG" }).requiredDocs;
const assigns: { employeeId: string; packetId: string; docs: string[] }[] = [];
const emails: TransactionalEmail[] = [];
const alarms: { employeeId: string; template: string; reason: string }[] = [];
// awaitApproval calls registerPending right AFTER setHandler(decideUpdate); resolving this signals the handler is up,
// so the test drives the Update only once it will be delivered to a registered handler (buffered updates are rejected
// at each activation's conclusion, so an update sent before recommendPacket returns would be dropped).
let onPendingRegistered: (() => void) | null = null;
const activities = {
  getEmployee: (c: string, e: string) => hris.getEmployee(c, e),
  recommendPacket: async (c: string, e: string) => new RulePacketRecommender().recommend(await hris.getEmployee(c, e)),
  assignPacket: async (_c: string, e: string, p: string, docs: string[]) => { assigns.push({ employeeId: e, packetId: p, docs }); return { receiptId: `asg-${assigns.length}` }; },
  sendEmail: async (email: TransactionalEmail) => { emails.push(email); return { messageId: `m-${emails.length}` }; },
  alarmDidNotSend: async (a: { employeeId: string; template: string; reason: string }) => { alarms.push(a); },
  registerPending: async () => { onPendingRegistered?.(); },
  resolvePending: async () => {},
};

describe("packetSelection (UC6 recommend → confirm → assign + email)", () => {
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let runPromise: Promise<void>;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    worker = await Worker.create({
      connection: env.nativeConnection, taskQueue: TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("../../src/usecases/packetSelection/workflow.ts", import.meta.url)),
      activities,
    });
    runPromise = worker.run();
  });
  afterAll(async () => {
    worker.shutdown();
    await runPromise.catch(() => {});
    await env.teardown();
  });

  it("approve with a chosen subset → assigns + emails exactly that subset", async () => {
    assigns.length = 0; emails.length = 0; alarms.length = 0;
    const registered = new Promise<void>((res) => { onPendingRegistered = res; });
    const handle = await env.client.workflow.start(packetSelection, {
      taskQueue: TASK_QUEUE, workflowId: "wf-pkt-e1", args: [{ companyId: "C1", employeeId: "E1" }],
    });
    await registered;
    await handle.executeUpdate(decideUpdate, { args: [{ approved: true, reason: "looks right", approver: "reviewer@instantteams.test", selectedDocs: ["I-9", "W-4"] }] });
    await handle.result();
    expect(assigns).toEqual([{ employeeId: "E1", packetId: "PKT-RFT-ENG", docs: ["I-9", "W-4"] }]);
    expect(emails.map((e) => e.templateAlias)).toEqual(["onboarding-packet"]);
    expect(emails[0].model.docs).toBe("I-9, W-4");
    expect(alarms).toHaveLength(0);
  });

  it("approve with no selection → defaults to the whole packet", async () => {
    assigns.length = 0; emails.length = 0; alarms.length = 0;
    const registered = new Promise<void>((res) => { onPendingRegistered = res; });
    const handle = await env.client.workflow.start(packetSelection, {
      taskQueue: TASK_QUEUE, workflowId: "wf-pkt-e1b", args: [{ companyId: "C1", employeeId: "E1" }],
    });
    await registered;
    await handle.executeUpdate(decideUpdate, { args: [{ approved: true, reason: "assign all", approver: "reviewer@instantteams.test" }] });
    await handle.result();
    expect(assigns[0].docs).toEqual(FULL_E1_DOCS);
    expect(emails[0].model.docs).toBe(FULL_E1_DOCS.join(", "));
  });

  it("reject → no assign, no email, fires a did-not-send alarm", async () => {
    assigns.length = 0; emails.length = 0; alarms.length = 0;
    const registered = new Promise<void>((res) => { onPendingRegistered = res; });
    const handle = await env.client.workflow.start(packetSelection, {
      taskQueue: TASK_QUEUE, workflowId: "wf-pkt-e2", args: [{ companyId: "C1", employeeId: "E2" }],
    });
    await registered;
    await handle.executeUpdate(decideUpdate, { args: [{ approved: false, reason: "wrong packet", approver: "reviewer@instantteams.test" }] });
    await handle.result();
    expect(assigns).toHaveLength(0);
    expect(emails).toHaveLength(0);
    expect(alarms.map((a) => a.template)).toEqual(["packet-assignment"]);
  });
});
