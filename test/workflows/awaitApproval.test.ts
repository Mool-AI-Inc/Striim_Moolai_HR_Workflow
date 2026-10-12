import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { mergeActivities } from "../../src/platform/worker.js";
import { decideUpdate } from "../../src/platform/approvals.js";
import { getApproval } from "../../src/platform/db/approvals.js";
import { migrate } from "../../src/platform/db/sendLedger.js";
import { closePool } from "../../src/platform/db/pool.js";
import type { PendingApproval } from "../../src/platform/domain/types.js";
import { approvalHostWorkflow } from "./fixtures/approvalHost.js";

const TASK_QUEUE = "approval-test";
const pendingOf = (id: string): PendingApproval => ({
  id, workflowId: `wf-${id}`, kind: "personnel-file", title: "review", detail: {}, createdAt: new Date().toISOString(), status: "pending",
});
// The client wraps a validator rejection in "Workflow Update failed"; the real cause is nested — walk the chain.
function messageChain(e: unknown): string {
  let out = "", cur: unknown = e;
  for (let i = 0; i < 6 && cur instanceof Error; i++) { out += " " + cur.message; cur = cur.cause; }
  return out;
}

describe("approval spine (awaitApproval)", () => {
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let runPromise: Promise<void>;

  beforeAll(async () => {
    await migrate();
    env = await TestWorkflowEnvironment.createTimeSkipping();
    worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("./fixtures/approvalHost.ts", import.meta.url)),
      activities: mergeActivities([]),
    });
    runPromise = worker.run();
  });
  afterAll(async () => {
    worker.shutdown();
    await runPromise.catch(() => {});
    await env.teardown();
    await closePool();
  });

  it("approve → resolves the decision and marks the row approved", async () => {
    const p = pendingOf("appr-approve");
    const handle = await env.client.workflow.start(approvalHostWorkflow, { taskQueue: TASK_QUEUE, workflowId: p.workflowId, args: [p, "7 days"] });
    await handle.executeUpdate(decideUpdate, { args: [{ approved: true, reason: "ok", approver: "t" }] });
    expect(await handle.result()).toMatchObject({ approved: true, reason: "ok" });
    expect((await getApproval(p.id))?.status).toBe("approved");
  });

  it("rejects an empty reason (validator)", async () => {
    const p = pendingOf("appr-empty");
    const handle = await env.client.workflow.start(approvalHostWorkflow, { taskQueue: TASK_QUEUE, workflowId: p.workflowId, args: [p, "7 days"] });
    const err = await handle.executeUpdate(decideUpdate, { args: [{ approved: true, reason: "", approver: "t" }] }).catch((e: unknown) => e);
    expect(messageChain(err)).toMatch(/reason required/i);
    // still pending — finish it so the workflow doesn't leak
    await handle.executeUpdate(decideUpdate, { args: [{ approved: false, reason: "cleanup", approver: "t" }] });
    await handle.result();
  });

  it("rejects a second decision (already decided / completed)", async () => {
    const p = pendingOf("appr-double");
    const handle = await env.client.workflow.start(approvalHostWorkflow, { taskQueue: TASK_QUEUE, workflowId: p.workflowId, args: [p, "7 days"] });
    await handle.executeUpdate(decideUpdate, { args: [{ approved: true, reason: "first", approver: "a" }] });
    await expect(handle.executeUpdate(decideUpdate, { args: [{ approved: true, reason: "second", approver: "b" }] })).rejects.toThrow();
    await handle.result();
  });

  it("expiry → resolves null and marks the row expired", async () => {
    const p = pendingOf("appr-expire");
    const result = await env.client.workflow.execute(approvalHostWorkflow, { taskQueue: TASK_QUEUE, workflowId: p.workflowId, args: [p, "10 seconds"] });
    expect(result).toBeNull();
    expect((await getApproval(p.id))?.status).toBe("expired");
  });
});
